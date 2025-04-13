let audioCtx = new AudioContext();
let config = {
  inputs: [],
  monitorDeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  outputMasterVolume: 1
};

async function setup() {
  config = await window.configAPI.loadConfig();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");

  const input1Sel = document.getElementById("input1");
  const input2Sel = document.getElementById("input2");
  const input3Sel = document.getElementById("input3");
  const monitorSel = document.getElementById("monitorDevice");
  const mixedSel = document.getElementById("mixedOutputDevice");
  const container = document.getElementById("sources");
  const monitorMasterSlider = document.getElementById("monitorMaster");
  const outputMasterSlider = document.getElementById("outputMaster");

  input1Sel.innerHTML = '<option value="">(None)</option>';
  input2Sel.innerHTML = '<option value="">(None)</option>';
  input3Sel.innerHTML = '<option value="">(None)</option>';
  monitorSel.innerHTML = '<option value="">(Default)</option>';
  mixedSel.innerHTML = '<option value="">(Default)</option>';

  inputs.forEach(d => {
    const opt1 = document.createElement("option");
    opt1.value = d.deviceId;
    opt1.textContent = d.label || "Unnamed Input";
    input1Sel.appendChild(opt1);

    const opt2 = opt1.cloneNode(true);
    input2Sel.appendChild(opt2);

    const opt3 = opt1.cloneNode(true);
    input3Sel.appendChild(opt3);
  });

  outputs.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || "Unnamed Output";
    monitorSel.appendChild(opt);

    const opt2 = opt.cloneNode(true);
    mixedSel.appendChild(opt2);
  });

  input1Sel.value = config.inputs?.[0]?.deviceId || "";
  input2Sel.value = config.inputs?.[1]?.deviceId || "";
  input3Sel.value = config.inputs?.[2]?.deviceId || "";
  monitorSel.value = config.monitorDeviceId || "";
  mixedSel.value = config.mixedOutputDeviceId || "";
  monitorMasterSlider.value = config.monitorMasterVolume || 1;
  outputMasterSlider.value = config.outputMasterVolume || 1;

  input1Sel.onchange = input2Sel.onchange = input3Sel.onchange = monitorSel.onchange = mixedSel.onchange = () => {
    config.inputs = [
      { deviceId: input1Sel.value, monitorVolume: 1, outputVolume: 1, monitorMute: false, outputMute: false },
      { deviceId: input2Sel.value, monitorVolume: 1, outputVolume: 1, monitorMute: false, outputMute: false },
      { deviceId: input3Sel.value, monitorVolume: 1, outputVolume: 1, monitorMute: false, outputMute: false }
    ].filter(input => input.deviceId);
    config.monitorDeviceId = monitorSel.value;
    config.mixedOutputDeviceId = mixedSel.value;
    window.configAPI.saveConfig(config);
    location.reload();
  };

  container.innerHTML = "";

  const monitorMasterGain = audioCtx.createGain();
  const outputMasterGain = audioCtx.createGain();
  monitorMasterGain.gain.value = parseFloat(monitorMasterSlider.value);
  outputMasterGain.gain.value = parseFloat(outputMasterSlider.value);

  monitorMasterSlider.oninput = () => {
    monitorMasterGain.gain.value = parseFloat(monitorMasterSlider.value);
    config.monitorMasterVolume = parseFloat(monitorMasterSlider.value);
    window.configAPI.saveConfig(config);
  };
  outputMasterSlider.oninput = () => {
    outputMasterGain.gain.value = parseFloat(outputMasterSlider.value);
    config.outputMasterVolume = parseFloat(outputMasterSlider.value);
    window.configAPI.saveConfig(config);
  };

  const monitorOut = audioCtx.createMediaStreamDestination();
  const mixedOut = audioCtx.createMediaStreamDestination();
  monitorMasterGain.connect(monitorOut);
  outputMasterGain.connect(mixedOut);

  for (let i = 0; i < config.inputs.length; i++) {
    const deviceId = config.inputs[i].deviceId;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },  // Ensure the device is selected
        echoCancellation: false,        // Disable echo cancellation
        noiseSuppression: false,        // Disable noise suppression
        autoGainControl: false          // Disable auto gain control
      }
    });    
    const input = audioCtx.createMediaStreamSource(stream);

    const settings = config.inputs[i];

    const monitorGain = audioCtx.createGain();
    const outputGain = audioCtx.createGain();

    monitorGain.gain.value = settings.monitorMute ? 0 : settings.monitorVolume;
    outputGain.gain.value = settings.outputMute ? 0 : settings.outputVolume;

    input.connect(monitorGain);
    input.connect(outputGain);
    monitorGain.connect(monitorMasterGain);
    outputGain.connect(outputMasterGain);

    const div = document.createElement("div");
    div.innerHTML = `
      <h3>Input ${i + 1}</h3>
      <label>Monitor Volume:
        <input type="range" min="0" max="1" step="0.01" value="${settings.monitorVolume}" class="monitorVol">
      </label>
      <label><input type="checkbox" class="monitorMute" ${settings.monitorMute ? "checked" : ""}> Mute Monitor</label><br>
      <label>Output Volume:
        <input type="range" min="0" max="1" step="0.01" value="${settings.outputVolume}" class="outputVol">
      </label>
      <label><input type="checkbox" class="outputMute" ${settings.outputMute ? "checked" : ""}> Mute Output</label>
      <hr>
    `;
    container.appendChild(div);

    const monVol = div.querySelector(".monitorVol");
    const outVol = div.querySelector(".outputVol");
    const monMute = div.querySelector(".monitorMute");
    const outMute = div.querySelector(".outputMute");

    monVol.oninput = () => {
      settings.monitorVolume = parseFloat(monVol.value);
      monitorGain.gain.value = monMute.checked ? 0 : settings.monitorVolume;
      window.configAPI.saveConfig(config);
    };
    outVol.oninput = () => {
      settings.outputVolume = parseFloat(outVol.value);
      outputGain.gain.value = outMute.checked ? 0 : settings.outputVolume;
      window.configAPI.saveConfig(config);
    };
    monMute.onchange = () => {
      settings.monitorMute = monMute.checked;
      monitorGain.gain.value = settings.monitorMute ? 0 : settings.monitorVolume;
      window.configAPI.saveConfig(config);
    };
    outMute.onchange = () => {
      settings.outputMute = outMute.checked;
      outputGain.gain.value = settings.outputMute ? 0 : settings.outputVolume;
      window.configAPI.saveConfig(config);
    };
  }

  const monitorAudio = new Audio();
  monitorAudio.srcObject = monitorOut.stream;
  monitorAudio.autoplay = true;
  if (typeof monitorAudio.setSinkId === "function" && config.monitorDeviceId) {
    try {
      await monitorAudio.setSinkId(config.monitorDeviceId);
    } catch (err) {
      console.warn("Failed to set monitor output device:", err);
    }
  }

  const mixedAudio = new Audio();
  mixedAudio.srcObject = mixedOut.stream;
  mixedAudio.autoplay = true;
  if (typeof mixedAudio.setSinkId === "function" && config.mixedOutputDeviceId) {
    try {
      await mixedAudio.setSinkId(config.mixedOutputDeviceId);
    } catch (err) {
      console.warn("Failed to set mixed output device:", err);
    }
  }
}

setup();
