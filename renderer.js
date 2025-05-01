let config = {
  inputs: [],
  monitorDeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  outputMasterVolume: 1,
  bassGain: 0,
  overloadGain: 1
};

let deviceStates = {};
let activeStreams = {};
let cleanupAudio = () => {};
let audioCtx = null;
let deviceLabelMap = {};
let gainMap = {
  monitorMaster: null,
  outputMaster: null,
  bassMonitor: null,
  bassOutput: null,
  overloadMonitor: null,
  overloadOutput: null,
  perInput: []
};

async function setup() {
  config = Object.assign(config, await window.configAPI.loadConfig());
  deviceStates = await window.deviceStateAPI.loadState();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");

  inputs.forEach(d => deviceLabelMap[d.deviceId] = d.label || "Unnamed Input");

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
  const bassSlider = document.getElementById("bassControl");
  const overloadSlider = document.getElementById("overloadControl");
  const bassDisplay = document.getElementById("bassDisplay");
  const overloadDisplay = document.getElementById("overloadDisplay");

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
  bassSlider.value = config.bassGain || 0;
  overloadSlider.value = config.overloadGain || 1;

  document.getElementById("monitorMasterDisplay").textContent = `${Math.round(config.monitorMasterVolume * 100)}%`;
  document.getElementById("outputMasterDisplay").textContent = `${Math.round(config.outputMasterVolume * 100)}%`;
  bassDisplay.textContent = `${parseFloat(bassSlider.value).toFixed(1)} dB`;
  overloadDisplay.textContent = `${Math.round(config.overloadGain * 100)}%`;

  const updateInputsFromUI = () => {
    for (let i = 0; i < 3; i++) {
      if (!config.inputs[i]) config.inputs[i] = {
        deviceId: "",
        monitorVolume: 1,
        outputVolume: 1,
        monitorMute: false,
        outputMute: false,
        forceMono: false
      };
      config.inputs[i].deviceId = inputSels[i].value;
    }
    config.monitorDeviceId = monitorSel.value;
    config.mixedOutputDeviceId = mixedSel.value;
    window.configAPI.saveConfig(config);
    buildAudioGraph();
  };

  inputSels.forEach(sel => sel.onchange = updateInputsFromUI);
  monitorSel.onchange = mixedSel.onchange = updateInputsFromUI;

  monitorMasterSlider.oninput = () => {
    config.monitorMasterVolume = parseFloat(monitorMasterSlider.value);
    document.getElementById("monitorMasterDisplay").textContent = `${Math.round(config.monitorMasterVolume * 100)}%`;
    if (gainMap.monitorMaster) gainMap.monitorMaster.gain.value = config.monitorMasterVolume;
    window.configAPI.saveConfig(config);
  };

  outputMasterSlider.oninput = () => {
    config.outputMasterVolume = parseFloat(outputMasterSlider.value);
    document.getElementById("outputMasterDisplay").textContent = `${Math.round(config.outputMasterVolume * 100)}%`;
    if (gainMap.outputMaster) gainMap.outputMaster.gain.value = config.outputMasterVolume;
    window.configAPI.saveConfig(config);
  };

  bassSlider.oninput = () => {
    let value = parseFloat(bassSlider.value);
    if (Math.abs(value) < 0.5) value = 0;
    config.bassGain = value;
    bassSlider.value = value;
    bassDisplay.textContent = `${value.toFixed(1)} dB`;
    if (gainMap.bassMonitor) gainMap.bassMonitor.gain.value = value;
    if (gainMap.bassOutput) gainMap.bassOutput.gain.value = value;
    window.configAPI.saveConfig(config);
  };

  overloadSlider.oninput = () => {
    config.overloadGain = parseFloat(overloadSlider.value);
    overloadDisplay.textContent = `${Math.round(config.overloadGain * 100)}%`;
    if (gainMap.overloadMonitor) gainMap.overloadMonitor.gain.value = config.overloadGain;
    if (gainMap.overloadOutput) gainMap.overloadOutput.gain.value = config.overloadGain;
    window.configAPI.saveConfig(config);
  };

  const resetButton = document.getElementById("resetAdvanced");
  if (resetButton) {
    resetButton.onclick = () => {
      config.bassGain = 0;
      config.overloadGain = 1;
      bassSlider.value = 0;
      overloadSlider.value = 1;
      bassDisplay.textContent = "0 dB";
      overloadDisplay.textContent = "100%";
      if (gainMap.bassMonitor) gainMap.bassMonitor.gain.value = 0;
      if (gainMap.bassOutput) gainMap.bassOutput.gain.value = 0;
      if (gainMap.overloadMonitor) gainMap.overloadMonitor.gain.value = 1;
      if (gainMap.overloadOutput) gainMap.overloadOutput.gain.value = 1;
      window.configAPI.saveConfig(config);
    };
  }

  buildAudioGraph();
}

async function buildAudioGraph() {
  if (cleanupAudio) cleanupAudio();

  if (audioCtx && typeof audioCtx.close === "function") {
    try { await audioCtx.close(); } catch (_) {}
  }

  audioCtx = new AudioContext();
  const nodeRefs = [];
  const monitorOut = audioCtx.createMediaStreamDestination();
  const mixedOut = audioCtx.createMediaStreamDestination();
  gainMap.perInput = [];

  const monitorMasterGain = audioCtx.createGain();
  const outputMasterGain = audioCtx.createGain();
  monitorMasterGain.gain.value = config.monitorMasterVolume;
  outputMasterGain.gain.value = config.outputMasterVolume;

  const bassEQMonitor = audioCtx.createBiquadFilter();
  bassEQMonitor.type = "lowshelf";
  bassEQMonitor.frequency.value = 250;
  bassEQMonitor.gain.value = config.bassGain;

  const bassEQOutput = audioCtx.createBiquadFilter();
  bassEQOutput.type = "lowshelf";
  bassEQOutput.frequency.value = 250;
  bassEQOutput.gain.value = config.bassGain;

  const overloadGainMonitor = audioCtx.createGain();
  const overloadGainOutput = audioCtx.createGain();
  overloadGainMonitor.gain.value = config.overloadGain;
  overloadGainOutput.gain.value = config.overloadGain;

  gainMap.monitorMaster = monitorMasterGain;
  gainMap.outputMaster = outputMasterGain;
  gainMap.bassMonitor = bassEQMonitor;
  gainMap.bassOutput = bassEQOutput;
  gainMap.overloadMonitor = overloadGainMonitor;
  gainMap.overloadOutput = overloadGainOutput;

  bassEQMonitor.connect(overloadGainMonitor).connect(monitorMasterGain).connect(monitorOut);
  bassEQOutput.connect(overloadGainOutput).connect(outputMasterGain).connect(mixedOut);

  nodeRefs.push(
    bassEQMonitor, overloadGainMonitor, monitorMasterGain,
    bassEQOutput, overloadGainOutput, outputMasterGain
  );

  const container = document.getElementById("sources");
  container.innerHTML = "";

  for (let i = 0; i < 3; i++) {
    const inputCfg = config.inputs[i];
    const deviceId = inputCfg.deviceId;
    const div = document.createElement("div");
    const label = deviceLabelMap[deviceId] || `Input ${i + 1}`;

    if (!deviceId) {
      div.innerHTML = `<h3>Input ${i + 1}</h3><p>(No device selected)</p><hr>`;
      container.appendChild(div);
      continue;
    }

    if (!activeStreams[deviceId]) {
      activeStreams[deviceId] = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    }

    const stream = activeStreams[deviceId];
    let inputNode = audioCtx.createMediaStreamSource(stream);
    nodeRefs.push(inputNode);

    if (inputCfg.forceMono) {
      const splitter = audioCtx.createChannelSplitter(2);
      const merger = audioCtx.createChannelMerger(2);
      inputNode.connect(splitter);
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 0, 1);
      inputNode = merger;
      nodeRefs.push(splitter, merger);
    }

    const monitorGain = audioCtx.createGain();
    const outputGain = audioCtx.createGain();
    monitorGain.gain.value = inputCfg.monitorMute ? 0 : inputCfg.monitorVolume;
    outputGain.gain.value = inputCfg.outputMute ? 0 : inputCfg.outputVolume;

    inputNode.connect(monitorGain).connect(bassEQMonitor);
    inputNode.connect(outputGain).connect(bassEQOutput);

    nodeRefs.push(monitorGain, outputGain);
    gainMap.perInput.push({ monitorGain, outputGain });

    div.innerHTML = `
      <h3>${label}</h3>
      <label>Monitor Volume:
        <input type="range" min="0" max="1" step="0.01" value="${inputCfg.monitorVolume}" class="monitorVol">
        <span class="monitorVolDisplay">${Math.round(inputCfg.monitorVolume * 100)}%</span>
      </label>
      <label><input type="checkbox" class="monitorMute" ${inputCfg.monitorMute ? "checked" : ""}> Mute Monitor</label><br>
      <label>Output Volume:
        <input type="range" min="0" max="1" step="0.01" value="${inputCfg.outputVolume}" class="outputVol">
        <span class="outputVolDisplay">${Math.round(inputCfg.outputVolume * 100)}%</span>
      </label>
      <label><input type="checkbox" class="outputMute" ${inputCfg.outputMute ? "checked" : ""}> Mute Output</label><br>
      <label><input type="checkbox" class="forceMono" ${inputCfg.forceMono ? "checked" : ""}> Force Mono</label>
      <hr>
    `;
    container.appendChild(div);

    const monVol = div.querySelector(".monitorVol");
    const outVol = div.querySelector(".outputVol");
    const monMute = div.querySelector(".monitorMute");
    const outMute = div.querySelector(".outputMute");
    const monoBox = div.querySelector(".forceMono");

    monVol.oninput = () => {
      inputCfg.monitorVolume = parseFloat(monVol.value);
      monitorGain.gain.value = inputCfg.monitorMute ? 0 : inputCfg.monitorVolume;
      monVol.nextElementSibling.textContent = `${Math.round(monVol.value * 100)}%`;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
    };

    outVol.oninput = () => {
      inputCfg.outputVolume = parseFloat(outVol.value);
      outputGain.gain.value = inputCfg.outputMute ? 0 : inputCfg.outputVolume;
      outVol.nextElementSibling.textContent = `${Math.round(outVol.value * 100)}%`;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
    };

    monMute.onchange = () => {
      inputCfg.monitorMute = monMute.checked;
      monitorGain.gain.value = inputCfg.monitorMute ? 0 : inputCfg.monitorVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
    };

    outMute.onchange = () => {
      inputCfg.outputMute = outMute.checked;
      outputGain.gain.value = inputCfg.outputMute ? 0 : inputCfg.outputVolume;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
    };

    monoBox.onchange = () => {
      inputCfg.forceMono = monoBox.checked;
      deviceStates[deviceId] = { ...inputCfg };
      window.deviceStateAPI.saveState(deviceStates);
      window.configAPI.saveConfig(config);
      buildAudioGraph();
    };
  }

  const monitorAudio = new Audio();
  monitorAudio.srcObject = monitorOut.stream;
  monitorAudio.autoplay = true;
  if (typeof monitorAudio.setSinkId === "function" && config.monitorDeviceId) {
    try {
      await monitorAudio.setSinkId(config.monitorDeviceId);
    } catch (_) {}
  }

  const mixedAudio = new Audio();
  mixedAudio.srcObject = mixedOut.stream;
  mixedAudio.autoplay = true;
  if (typeof mixedAudio.setSinkId === "function" && config.mixedOutputDeviceId) {
    try {
      await mixedAudio.setSinkId(config.mixedOutputDeviceId);
    } catch (_) {}
  }

  cleanupAudio = () => {
    nodeRefs.forEach(node => {
      try {
        node.disconnect();
      } catch (_) {}
    });
    monitorAudio.pause();
    mixedAudio.pause();
  };
}

setup();
