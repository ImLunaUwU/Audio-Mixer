// AppRouter.exe: per-application output device routing for Audio Mixer.
//
// Uses the same undocumented Windows API as the "App volume and device preferences"
// page in Windows Settings (and EarTrumpet): IAudioPolicyConfigFactory from the
// Windows.Media.Internal.AudioPolicyConfig activation factory.
//
// Commands (UTF-8 output, one record per line, tab separated):
//   AppRouter.exe list                      -> "<isDefault 0|1>\t<endpoint id>\t<friendly name>" for active render devices
//   AppRouter.exe get <pid>                 -> persisted render endpoint id for the process (empty line = Windows default)
//   AppRouter.exe set <endpoint id|-> <pid> [pid ...]
//                                           -> persist the render endpoint ("-" clears it, back to the Windows default)
// Exit code 0 on success. On failure a message is written to stderr and the exit code is non-zero.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <roapi.h>
#include <winstring.h>
#include <inspectable.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cwchar>

namespace {

// Windows 10 21H2+ / Windows 11.
const IID IID_AudioPolicyConfigFactory21H2 = { 0xab3d4648, 0xe242, 0x459f, { 0xb0, 0x2f, 0x54, 0x1c, 0x70, 0x30, 0x63, 0x24 } };
// Windows 10 1803 to 21H1.
const IID IID_AudioPolicyConfigFactoryDownlevel = { 0x2a59116d, 0x6c4f, 0x45e0, { 0xa7, 0x4f, 0x70, 0x7e, 0x3f, 0xef, 0x92, 0x58 } };

const wchar_t kDevicePrefix[] = L"\\\\?\\SWD#MMDEVAPI#";
const wchar_t kRenderInterface[] = L"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";

// Both IID variants share this vtable layout: IInspectable (6 slots), 19 methods we do not use,
// then Set/Get/ClearAll persisted default endpoint.
constexpr int kSetPersistedSlot = 25;
constexpr int kGetPersistedSlot = 26;

typedef HRESULT(STDMETHODCALLTYPE* SetPersistedFn)(void* self, UINT32 processId, EDataFlow flow, ERole role, HSTRING deviceId);
typedef HRESULT(STDMETHODCALLTYPE* GetPersistedFn)(void* self, UINT32 processId, EDataFlow flow, ERole role, HSTRING* deviceId);

void WriteUtf8(FILE* stream, const std::wstring& text) {
  if (text.empty()) return;
  int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), &out[0], size, nullptr, nullptr);
  fwrite(out.data(), 1, out.size(), stream);
}

int Fail(const wchar_t* what, HRESULT hr) {
  wchar_t buffer[512];
  swprintf(buffer, 512, L"%ls failed (0x%08lX)\n", what, (unsigned long)hr);
  WriteUtf8(stderr, buffer);
  return 2;
}

std::wstring Sanitize(std::wstring value) {
  for (auto& ch : value) if (ch == L'\t' || ch == L'\r' || ch == L'\n') ch = L' ';
  return value;
}

bool ParsePid(const wchar_t* text, UINT32* pid) {
  if (!text || !*text) return false;
  wchar_t* end = nullptr;
  unsigned long value = wcstoul(text, &end, 10);
  if (!end || *end != L'\0' || value == 0 || value > 0xFFFFFFFFul) return false;
  *pid = (UINT32)value;
  return true;
}

// "{0.0.0.00000000}.{guid}" -> "\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{render interface}"
std::wstring ToFullId(const std::wstring& shortId) { return kDevicePrefix + shortId + kRenderInterface; }

std::wstring ToShortId(const std::wstring& fullId) {
  std::wstring id = fullId;
  size_t start = id.find(L"MMDEVAPI#");
  if (start != std::wstring::npos) id = id.substr(start + 9);
  size_t hash = id.find(L"#{");
  if (hash != std::wstring::npos) id = id.substr(0, hash);
  return id;
}

HRESULT GetFactory(void** factory) {
  HSTRING className = nullptr;
  const wchar_t name[] = L"Windows.Media.Internal.AudioPolicyConfig";
  HRESULT hr = WindowsCreateString(name, (UINT32)wcslen(name), &className);
  if (FAILED(hr)) return hr;
  hr = RoGetActivationFactory(className, IID_AudioPolicyConfigFactory21H2, factory);
  if (FAILED(hr)) hr = RoGetActivationFactory(className, IID_AudioPolicyConfigFactoryDownlevel, factory);
  WindowsDeleteString(className);
  return hr;
}

void** Vtbl(void* object) { return *reinterpret_cast<void***>(object); }

int CmdList() {
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) return Fail(L"MMDeviceEnumerator", hr);

  std::wstring defaultId;
  IMMDevice* def = nullptr;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def))) {
    LPWSTR id = nullptr;
    if (SUCCEEDED(def->GetId(&id))) { defaultId = id; CoTaskMemFree(id); }
    def->Release();
  }

  IMMDeviceCollection* collection = nullptr;
  hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(hr)) { enumerator->Release(); return Fail(L"EnumAudioEndpoints", hr); }
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice* device = nullptr;
    if (FAILED(collection->Item(i, &device))) continue;
    LPWSTR id = nullptr;
    std::wstring name;
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT value;
      PropVariantInit(&value);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR && value.pwszVal) name = value.pwszVal;
      PropVariantClear(&value);
      props->Release();
    }
    if (SUCCEEDED(device->GetId(&id))) {
      std::wstring line = std::wstring(defaultId == id ? L"1" : L"0") + L"\t" + Sanitize(id) + L"\t" + Sanitize(name) + L"\n";
      WriteUtf8(stdout, line);
      CoTaskMemFree(id);
    }
    device->Release();
  }
  collection->Release();
  enumerator->Release();
  return 0;
}

int CmdGet(UINT32 pid) {
  void* factory = nullptr;
  HRESULT hr = GetFactory(&factory);
  if (FAILED(hr)) return Fail(L"AudioPolicyConfig activation", hr);
  HSTRING value = nullptr;
  hr = reinterpret_cast<GetPersistedFn>(Vtbl(factory)[kGetPersistedSlot])(factory, pid, eRender, eMultimedia, &value);
  std::wstring id;
  if (SUCCEEDED(hr) && value) {
    UINT32 length = 0;
    const wchar_t* raw = WindowsGetStringRawBuffer(value, &length);
    id = ToShortId(std::wstring(raw, length));
    WindowsDeleteString(value);
  }
  reinterpret_cast<IUnknown*>(factory)->Release();
  if (FAILED(hr)) return Fail(L"GetPersistedDefaultAudioEndpoint", hr);
  WriteUtf8(stdout, id + L"\n");
  return 0;
}

int CmdSet(const std::wstring& shortId, const std::vector<UINT32>& pids) {
  void* factory = nullptr;
  HRESULT hr = GetFactory(&factory);
  if (FAILED(hr)) return Fail(L"AudioPolicyConfig activation", hr);
  HSTRING value = nullptr;
  if (!shortId.empty()) {
    std::wstring full = ToFullId(shortId);
    hr = WindowsCreateString(full.c_str(), (UINT32)full.size(), &value);
    if (FAILED(hr)) { reinterpret_cast<IUnknown*>(factory)->Release(); return Fail(L"WindowsCreateString", hr); }
  }
  auto set = reinterpret_cast<SetPersistedFn>(Vtbl(factory)[kSetPersistedSlot]);
  int failures = 0;
  HRESULT lastError = S_OK;
  for (UINT32 pid : pids) {
    HRESULT a = set(factory, pid, eRender, eConsole, value);
    HRESULT b = set(factory, pid, eRender, eMultimedia, value);
    if (FAILED(a) || FAILED(b)) { failures++; lastError = FAILED(a) ? a : b; }
  }
  if (value) WindowsDeleteString(value);
  reinterpret_cast<IUnknown*>(factory)->Release();
  if (failures == (int)pids.size()) return Fail(L"SetPersistedDefaultAudioEndpoint", lastError);
  return 0;
}

int Usage() {
  WriteUtf8(stderr, L"usage: AppRouter.exe list | get <pid> | set <endpoint id|-> <pid> [pid ...]\n");
  return 1;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return Usage();
  HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return Fail(L"RoInitialize", hr);

  int result = 1;
  std::wstring command = argv[1];
  if (command == L"list") {
    result = CmdList();
  } else if (command == L"get" && argc == 3) {
    UINT32 pid = 0;
    result = ParsePid(argv[2], &pid) ? CmdGet(pid) : Usage();
  } else if (command == L"set" && argc >= 4) {
    std::wstring id = argv[2];
    if (id == L"-") id.clear();
    std::vector<UINT32> pids;
    bool ok = true;
    for (int i = 3; i < argc && ok; i++) {
      UINT32 pid = 0;
      ok = ParsePid(argv[i], &pid);
      pids.push_back(pid);
    }
    result = ok ? CmdSet(id, pids) : Usage();
  } else {
    result = Usage();
  }
  fflush(stdout);
  RoUninitialize();
  return result;
}
