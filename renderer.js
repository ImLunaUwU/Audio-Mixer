let audioCtx = new AudioContext();
let config = {
  inputs: [],
  monitorDeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  outputMasterVolume: 1
};

let deviceStates = {};

async function setup() {
  config = await window.configAPI.loadConfig();
  deviceStates = await window.deviceStateAPI.loadState();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");

  const inputSels = [
    document.getElementById("input1"),
    document.getElementById("input2"),
    document.getElementById("input3")
  ];
  const monitorSel = document.getElementById("monitorDevice");
  const mixedSel = document.getElementById("mixedOutputDevice");
  const container = document.getElementById("sources");
  const monitorMasterSlider = document.getElementById("monitorMaster");
  const outputMasterSlider = document.getElementById("outputMaster");

  inputSels.forEach(sel => sel.innerHTML = '<option value="">(None)</option>');
  monitorSel.innerHTML = '<option value="">(Default)</option>';
  mixedSel.innerHTML = '<option value="">(Default)</option>';

  inputs.forEach(d => {
    inputSels.forEach(sel => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Unnamed Input";
      sel.appendChild(opt);
    });
  });

  outputs.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || "Unnamed Output";
    monitorSel.appendChild(opt);
    mixedSel.appendChild(opt.cloneNode(true));
  });

  for (let i = 0; i < 3; i++) {
    const inputCfg = config.inputs[i] || {};
    inputSels[i].value = inputCfg.deviceId || "";
  }
  monitorSel.value = config.monitorDeviceId || "";
  mixedSel.value = config.mixedOutputDeviceId || "";
  monitorMasterSlider.value = config.monitorMasterVolume || 1;
  outputMasterSlider.value = config.outputMasterVolume || 1;

  const updateInputsFromUI = () => {
    for (let i = 0; i < 3; i++) {
      if (!config.inputs[i]) config.inputs[i] = {
        deviceId: "",
        monitorVolume: 1,
        outputVolume: 1,
        monitorMute: false,
        outputMute: false
      };
      config.inputs[i].deviceId = inputSels[i].value;
    }
    config.monitorDeviceId = monitorSel.value;
    config.mixedOutputDeviceId = mixedSel.value;
    window.configAPI.saveConfig(config);
    location.reload();
  };

  inputSels.forEach(sel => sel.onchange = updateInputsFromUI);
  monitorSel.onchange = mixedSel.onchange = updateInputsFromUI;

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

  for (let i = 0; i < 3; i++) {
    const inputCfg = config.inputs[i];
    const deviceId = inputCfg.deviceId;
    const div = document.createElement("div");
    const label = inputs.find(d => d.deviceId === deviceId)?.label || `(Input ${i + 1})`;

    div.innerHTML = `<h3>${label}</h3>`;

    if (!deviceId) {
      div.innerHTML += `<p>(No device selected)</p><hr>`;
      container.appendChild(div);
      continue;
    }

    const state = deviceStates[deviceId] || {
      monitorVolume: inputCfg.monitorVolume,
      outputVolume: inputCfg.outputVolume,
      monitorMute: inputCfg.monitorMute,
      outputMute: inputCfg.outputMute
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    const input = audioCtx.createMediaStreamSource(stream);

    const monitorGain = audioCtx.createGain();
    const outputGain = audioCtx.createGain();
    monitorGain.gain.value = state.monitorMute ? 0 : state.monitorVolume;
    outputGain.gain.value = state.outputMute ? 0 : state.outputVolume;

    input.connect(monitorGain);
    input.connect(outputGain);
    monitorGain.connect(monitorMasterGain);
    outputGain.connect(outputMasterGain);

    div.innerHTML += `
      <label>Monitor Volume:
        <input type="range" min="0" max="1" step="0.01" value="${state.monitorVolume}" class="monitorVol">
      </label>
      <label><input type="checkbox" class="monitorMute" ${state.monitorMute ? "checked" : ""}> Mute Monitor</label><br>
      <label>Output Volume:
        <input type="range" min="0" max="1" step="0.01" value="${state.outputVolume}" class="outputVol">
      </label>
      <label><input type="checkbox" class="outputMute" ${state.outputMute ? "checked" : ""}> Mute Output</label>
      <hr>
    `;
    container.appendChild(div);

    inputCfg.monitorVolume = state.monitorVolume;
    inputCfg.outputVolume = state.outputVolume;
    inputCfg.monitorMute = state.monitorMute;
    inputCfg.outputMute = state.outputMute;

    const monVol = div.querySelector(".monitorVol");
    const outVol = div.querySelector(".outputVol");
    const monMute = div.querySelector(".monitorMute");
    const outMute = div.querySelector(".outputMute");

    monVol.oninput = () => {
      inputCfg.monitorVolume = parseFloat(monVol.value);
      monitorGain.gain.value = monMute.checked ? 0 : inputCfg.monitorVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
      window.configAPI.saveConfig(config);
    };
    outVol.oninput = () => {
      inputCfg.outputVolume = parseFloat(outVol.value);
      outputGain.gain.value = outMute.checked ? 0 : inputCfg.outputVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
      window.configAPI.saveConfig(config);
    };
    monMute.onchange = () => {
      inputCfg.monitorMute = monMute.checked;
      monitorGain.gain.value = inputCfg.monitorMute ? 0 : inputCfg.monitorVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
      window.configAPI.saveConfig(config);
    };
    outMute.onchange = () => {
      inputCfg.outputMute = outMute.checked;
      outputGain.gain.value = inputCfg.outputMute ? 0 : inputCfg.outputVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
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