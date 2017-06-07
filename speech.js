/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Creation of the configuration object
// that will be pick by emscripten module
var Module;

(function() {

    Module = {
        preRun: [],
        postRun: [],
        print: (function() {
            return function(text) {
                console.log("[webrtc_vad.js print]", text);
            };
        })(),
        printErr: function(text) {
            console.error("[webrtc_vad.js error]", text);
        },
        canvas: (function() {
        })(),
        setStatus: function(text) {
            console.log("[webrtc_vad.js status] ", text);
        },
        totalDependencies: 0,
        monitorRunDependencies: function(left) {
            this.totalDependencies = Math.max(this.totalDependencies, left);
            Module.setStatus(left ? "Preparing... (" + (this.totalDependencies-left) + "/" + this.totalDependencies + ")" : "All downloads complete.");
        }
    };
    Module.setStatus("Loading webrtc_vad...");
    window.onerror = function(event) {
        // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
        Module.setStatus("Exception thrown, see JavaScript console");
        Module.setStatus = function(text) {
            if (text) {
                Module.printErr("[post-exception status] " + text);
            }
        };
    };
    Module.noInitialRun = false;
    Module["onRuntimeInitialized"] = function() {
        stm_vad = new SpeakToMeVad();
        Module.setStatus("Webrtc_vad and SpeakToMeVad loaded");
    };

    var stm_vad;

    // move to a separated js
    var importScript = (function (oHead) {

          function loadError (oError) {
            console.log("The script " + oError.target.src + " is not accessible.");
          }

          // handle node.js loadings
          return function (sSrc, fOnload) {
            var oScript = document.createElement("script");
            oScript.type = "text\/javascript";
            oScript.onerror = loadError;
            if (fOnload) { oScript.onload = fOnload; }
            oHead.appendChild(oScript);
            oScript.src = sSrc;
          }

    })(document.head || document.getElementsByTagName("head")[0]);

    // Webrtc_Vad integration
    let SpeakToMeVad = function SpeakToMeVad() {

        this.webrtc_main = Module.cwrap("main");
        this.webrtc_main();
        this.webrtc_setmode = Module.cwrap("setmode", "number", ["number"]);
        // set_mode defines the aggressiveness degree of the voice activity detection algorithm
        // for more info see: https://github.com/mozilla/gecko/blob/central/media/webrtc/trunk/webrtc/common_audio/vad/vad_core.h#L68
        this.webrtc_setmode(3);
        this.webrtc_process_data = Module.cwrap("process_data", "number", ["number", "number", "number", "number", "number", "number"]);
        // frame length that should be passed to the vad engine. Depends on audio sample rate
        // https://github.com/mozilla/gecko/blob/central/media/webrtc/trunk/webrtc/common_audio/vad/vad_core.h#L106
        this.sizeBufferVad = 480;
        // minimum of activity (in milliseconds) that should be captured to be considered voice
        this.minvoice = 250;
        // max amount of silence (in milliseconds) that should be captured to be considered end-of-speech
        this.maxsilence = 1500;
        // max amount of capturing time (in seconds)
        this.maxtime = 6;

        this.reset = function() {
            this.buffer_vad = new Int16Array(this.sizeBufferVad);
            this.leftovers = 0;
            this.finishedvoice = false;
            this.samplesvoice = 0 ;
            this.samplessilence = 0 ;
            this.touchedvoice = false;
            this.touchedsilence = false;
            this.dtantes = Date.now();
            this.dtantesmili = Date.now();
            this.raisenovoice = false;
            this.done = false;
        }
        // function that returns if the specified buffer has silence of speech
        this.isSilence = function(buffer_pcm) {
            // Get data byte size, allocate memory on Emscripten heap, and get pointer
            let nDataBytes = buffer_pcm.length * buffer_pcm.BYTES_PER_ELEMENT;
            let dataPtr = Module._malloc(nDataBytes);
            // Copy data to Emscripten heap (directly accessed from Module.HEAPU8)
            let dataHeap = new Uint8Array(Module.HEAPU8.buffer, dataPtr, nDataBytes);
            dataHeap.set(new Uint8Array(buffer_pcm.buffer));
            // Call function and get result
            let result = this.webrtc_process_data(dataHeap.byteOffset, buffer_pcm.length, 48000, buffer_pcm[0], buffer_pcm[100], buffer_pcm[2000]);
            // Free memory
            Module._free(dataHeap.byteOffset);
            return result;
        }

        this.floatTo16BitPCM = function(output, input) {
            for (let i = 0; i < input.length; i++) {
                let s = Math.max(-1, Math.min(1, input[i]));
                output[i] =  s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
        }

        this.recorderProcess = function(e) {
            let buffer_pcm = new Int16Array(e.inputBuffer.getChannelData(0).length);
            stm_vad.floatTo16BitPCM(buffer_pcm, e.inputBuffer.getChannelData(0));
            // algorithm used to determine if the user stopped speaking or not
            for (let i = 0; i < Math.ceil(buffer_pcm.length/stm_vad.sizeBufferVad) && !stm_vad.done; i++) {
                let start = i * stm_vad.sizeBufferVad;
                let end = start+stm_vad.sizeBufferVad;
                if ((start + stm_vad.sizeBufferVad) > buffer_pcm.length) {
                    // store to the next buffer
                    stm_vad.buffer_vad.set(buffer_pcm.slice(start));
                    stm_vad.leftovers =  buffer_pcm.length - start;
                } else {
                    if (stm_vad.leftovers > 0) {
                        // we have this.leftovers from previous array
                        end = end - this.leftovers;
                        stm_vad.buffer_vad.set((buffer_pcm.slice(start, end)), stm_vad.leftovers);
                        stm_vad.leftovers =  0;
                    } else {
                        // send to the vad
                        stm_vad.buffer_vad.set(buffer_pcm.slice(start, end));
                    }
                    let vad = stm_vad.isSilence(stm_vad.buffer_vad);
                    stm_vad.buffer_vad = new Int16Array(stm_vad.sizeBufferVad);
                    let dtdepois = Date.now();
                    if (vad == 0) {
                        if (stm_vad.touchedvoice) {
                            stm_vad.samplessilence += dtdepois - stm_vad.dtantesmili;
                            if (stm_vad.samplessilence >  stm_vad.maxsilence) {
                                stm_vad.touchedsilence = true;
                            }
                        }
                    }
                    else {
                        stm_vad.samplesvoice  += dtdepois - stm_vad.dtantesmili;
                        if (stm_vad.samplesvoice >  stm_vad.minvoice) {
                            stm_vad.touchedvoice = true;
                        }
                    }
                    stm_vad.dtantesmili = dtdepois;
                    if (stm_vad.touchedvoice && stm_vad.touchedsilence) {
                        stm_vad.finishedvoice = true;
                    }
                    if (stm_vad.finishedvoice) {
                        stm_vad.done = true;
                        stm_vad.goCloud("GoCloud finishedvoice");
                    }
                    if ((dtdepois - stm_vad.dtantes)/1000 > stm_vad.maxtime ) {
                        stm_vad.done = true;
                        if (stm_vad.touchedvoice) {
                            stm_vad.goCloud("GoCloud timeout");
                        } else {
                            stm_vad.goCloud("Raise novoice");
                            stm_vad.raisenovoice = true;
                        }
                    }
                }
            }
        }

        this.goCloud = function(why) {
            console.log(why);
            this.stopGum();
        }
        console.log("speakToMeVad created()");
    }

    var load_vad = (function() {
        importScript("webrtc_vad.js", /* onload function: */ function () {
            console.log("webrtc_vad has been correctly loaded.");
        });
    });

    var mozillaSpeech = (function() {

        let stt_server_url = "http://54.183.226.82:9001/asr";
        let webrtc_main;

        var mozillaSpeech = function(options) {

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.error("You need a browser with getUserMedia support to use Speak To Me, sorry!");
                return;
            }

            load_vad();

            console.log('constructor', options);
        };

        mozillaSpeech.prototype.start = function foo() {
            console.log('start');
            let constraints = { audio: true };
            let chunks = [];

            navigator.mediaDevices.getUserMedia(constraints)
                .then(function(stream) {
                    // Build the WebAudio graph we'll be using
                    let audioContext = new AudioContext();
                    let sourceNode = audioContext.createMediaStreamSource(stream);
                    let analyzerNode = audioContext.createAnalyser();
                    let outputNode = audioContext.createMediaStreamDestination();
                    // make sure we're doing mono everywhere
                    sourceNode.channelCount = 1;
                    analyzerNode.channelCount = 1;
                    outputNode.channelCount = 1;
                    // connect the nodes together
                    sourceNode.connect(analyzerNode);
                    analyzerNode.connect(outputNode);
                    // and set up the recorder
                    let options = {
                        audioBitsPerSecond : 16000,
                        mimeType : "audio/ogg"
                    }

                    // VAD initializations
                    // console.log("Sample rate: ", audioContext.sampleRate);
                    let bufferSize = 2048;
                    //create a javascript node
                    let scriptprocessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
                    // specify the processing function
                    stm_vad.reset();
                    scriptprocessor.onaudioprocess = stm_vad.recorderProcess;
                    stm_vad.stopGum = () => {
                        console.log("stopGum");
                        mediaRecorder.stop();
                        sourceNode.disconnect(scriptprocessor);
                        sourceNode.disconnect(analyzerNode);
                        analyzerNode.disconnect(outputNode);
                    }
                    // connect stream to our recorder
                    sourceNode.connect(scriptprocessor);

                    // MediaRecorder initialization
                    let mediaRecorder = new MediaRecorder(outputNode.stream, options);
                    SpeakToMePopup.showAt(event.clientX, event.clientY);

                    SpeakToMePopup.wait_for_stop().then(() => {
                        mediaRecorder.stop();
                    });

                    document.getElementById("stm-levels").hidden = false;
                    visualize(analyzerNode);

                    mediaRecorder.start();

                    mediaRecorder.onstop = (e) => {
                        document.getElementById("stm-levels").hidden = true;
                        console.log("mediaRecorder onStop");
                        // We stopped the recording, send the content to the STT server.
                        mediaRecorder = null;
                        audioContext = null;
                        sourceNode = null;
                        analyzerNode = null;
                        outputNode = null;
                        stream = null;
                        scriptprocessor = null;

                        let blob = new Blob(chunks, { "type" : "audio/ogg; codecs=opus" });
                        chunks = [];

                        if (LOCAL_TEST) {
                            let json = JSON.parse('{"status":"ok","data":[{"confidence":0.807493,"text":"PLEASE ADD MILK TO MY SHOPPING LIST"},{"confidence":0.906263,"text":"PLEASE AT MILK TO MY SHOPPING LIST"},{"confidence":0.904414,"text":"PLEASE ET MILK TO MY SHOPPING LIST"}]}');
                            if (json.status == "ok") {
                                display_options(json.data);
                            }
                            return;
                        }

                    fetch(stt_server_url, {
                        method: "POST",
                        body: blob
                        })
                    .then((response) => { return response.json(); })
                    .then((json) => {
                        console.log(`Got STT result: ${JSON.stringify(json)}`);
                        if (json.status == "ok") {
                            display_options(json.data);
                        }
                    })
                    .catch((error) => {
                        console.error(`Fetch error: ${error}`);
                    });
                }

                    mediaRecorder.ondataavailable = (e) => {
                    chunks.push(e.data);
                }
            })
            .catch(function(err) {
                console.log(`Recording error: ${err}`);
            });
        };

        return mozillaSpeech;
    })();

    if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
        module.exports = mozillaSpeech;
    } else {
        if (typeof define === 'function' && define.amd) {
          define([], function() {
            return mozillaSpeech;
          });
        } else {
            window.mozillaSpeech = mozillaSpeech;
        }
    }

})();


