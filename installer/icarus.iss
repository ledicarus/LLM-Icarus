; LLM Icarus installer (Inno Setup 6). Build with installer\build.ps1.
; Installs per-user (no admin needed) and offers to download the parts that make it work.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{B7A0C4E2-5F1D-4C8A-9D3E-6A1E2F7B4C10}
AppName=LLM Icarus
AppVersion={#AppVersion}
AppVerName=LLM Icarus {#AppVersion}
DefaultDirName={localappdata}\Programs\LLM Icarus
DefaultGroupName=LLM Icarus
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=LLM-Icarus-Setup-{#AppVersion}
SetupIconFile=icarus.ico
UninstallDisplayIcon={app}\icarus.ico
WizardSmallImageFile=wizard-small.bmp
WizardImageFile=wizard-side.bmp
InfoBeforeFile=..\THIRD_PARTY_NOTICES.txt
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
; models and Python packages are big: warn about disk space on the chosen drive
DiskSpanning=no

[Types]
Name: "recommended"; Description: "Recommended: install everything needed (downloads the parts below automatically)"
Name: "minimal"; Description: "App only: I will download the parts myself later"
Name: "custom"; Description: "Custom: choose which parts to download"; Flags: iscustom

[Components]
Name: "app"; Description: "LLM Icarus application (required)"; Types: recommended minimal custom; Flags: fixed
Name: "engine"; Description: "Chat and Code engine, llama.cpp (download about 0.6 GB)"; Types: recommended; ExtraDiskSpaceRequired: 800000000
Name: "whisper"; Description: "Transcribe: private Python + Whisper (download about 1.5 GB)"; Types: recommended; ExtraDiskSpaceRequired: 3000000000
Name: "whispermodel"; Description: "Whisper large-v3 speech model now (about 3 GB; otherwise fetched on first use)"; Types: custom; ExtraDiskSpaceRequired: 3200000000
Name: "image"; Description: "Image generation: PyTorch + diffusers, NVIDIA GPU only (download about 5 GB)"; Types: recommended; ExtraDiskSpaceRequired: 9000000000
Name: "vector"; Description: "Vector: tracing and EPS tools (download about 40 MB)"; Types: recommended; ExtraDiskSpaceRequired: 150000000
Name: "threed"; Description: "3D: OpenSCAD and carving tools for STL files (download about 80 MB)"; Types: recommended; ExtraDiskSpaceRequired: 300000000
Name: "starter"; Description: "Starter chat/code model: Qwen3-8B (download about 5 GB)"; Types: recommended; ExtraDiskSpaceRequired: 5100000000
Name: "sdxl"; Description: "SDXL base image model (download about 7 GB)"; Types: custom; ExtraDiskSpaceRequired: 7000000000

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "claudeskill"; Description: "Let Claude Code send prompts to LLM Icarus (adds a small skill to your .claude\skills folder)"; GroupDescription: "Claude Code:"; Flags: unchecked

[Files]
Source: "..\server\*"; DestDir: "{app}\server"; Excludes: "__pycache__"; Flags: recursesubdirs ignoreversion; Components: app
Source: "..\web\*"; DestDir: "{app}\web"; Flags: recursesubdirs ignoreversion; Components: app
Source: "..\start.ps1"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "..\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion; Components: app
Source: "out\LLM Icarus.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "out\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "out\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "out\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "webview2\LICENSE.txt"; DestDir: "{app}\licenses\WebView2"; Flags: ignoreversion; Components: app
Source: "webview2\NOTICE.txt"; DestDir: "{app}\licenses\WebView2"; Flags: ignoreversion; Components: app
Source: "icarus.ico"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "download-components.cmd"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "..\API.md"; DestDir: "{app}"; Flags: ignoreversion; Components: app
Source: "..\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion; Components: app
; the Claude Code skill: always kept with the app (so it can be copied by hand), copied into the user's skills folder only if asked
Source: "..\claude-skill\*"; DestDir: "{app}\claude-skill"; Flags: ignoreversion; Components: app
Source: "..\claude-skill\*"; DestDir: "{%USERPROFILE}\.claude\skills\llm-icarus"; Flags: ignoreversion; Components: app; Tasks: claudeskill

[Icons]
Name: "{autoprograms}\LLM Icarus"; Filename: "{app}\LLM Icarus.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icarus.ico"; Comment: "Chat, code, transcribe and generate images with local models"
Name: "{autoprograms}\LLM Icarus - Download components"; Filename: "{app}\download-components.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\icarus.ico"; Comment: "Download the engine, Whisper, image tools and models"
Name: "{autodesktop}\LLM Icarus"; Filename: "{app}\LLM Icarus.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icarus.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\LLM Icarus.exe"; WorkingDir: "{app}"; Description: "Launch LLM Icarus"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\licenses"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\claude-skill"
Type: filesandordirs; Name: "{%USERPROFILE}\.claude\skills\llm-icarus"

[Code]
const
  IDX_ENGINE = 1;
  IDX_WHISPER = 2;
  IDX_WHISPERMODEL = 3;
  IDX_IMAGE = 4;
  IDX_VECTOR = 5;
  IDX_THREED = 6;
  IDX_STARTER = 7;
  IDX_SDXL = 8;

function HasNvidiaGpu: Boolean;
begin
  Result := FileExists(ExpandConstant('{sys}\nvcuda.dll'));
end;

// Image generation needs an NVIDIA GPU: don't offer it on machines without one.
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectComponents) and not HasNvidiaGpu then
  begin
    WizardForm.ComponentsList.Checked[IDX_IMAGE] := False;
    WizardForm.ComponentsList.ItemEnabled[IDX_IMAGE] := False;
    WizardForm.ComponentsList.Checked[IDX_SDXL] := False;
    WizardForm.ComponentsList.ItemEnabled[IDX_SDXL] := False;
  end;
end;

function SetupArgs: String;
begin
  Result := '';
  if WizardIsComponentSelected('engine') then Result := Result + ' --engine';
  if WizardIsComponentSelected('whisper') then Result := Result + ' --whisper';
  if WizardIsComponentSelected('whispermodel') then Result := Result + ' --whisper-model';
  if WizardIsComponentSelected('image') then Result := Result + ' --image';
  if WizardIsComponentSelected('vector') then Result := Result + ' --vector';
  if WizardIsComponentSelected('threed') then Result := Result + ' --threed';
  if WizardIsComponentSelected('starter') then Result := Result + ' --starter-model';
  if WizardIsComponentSelected('sdxl') then Result := Result + ' --sdxl-model';
end;

// After the files are copied, run the downloads in a visible console so progress can be seen.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Args, Cmd: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  Args := SetupArgs;
  if Args = '' then Exit;
  Cmd := '/c ""' + ExpandConstant('{app}\runtime\node.exe') + '" "' + ExpandConstant('{app}\server\setup.js') + '"' + Args;
  if not WizardSilent then Cmd := Cmd + ' & echo. & echo You can close this window. & pause';
  Cmd := Cmd + '"';
  WizardForm.StatusLabel.Caption := 'Downloading components (a console window shows progress)...';
  if Exec(ExpandConstant('{cmd}'), Cmd, ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) then
  begin
    if (Code <> 0) and not WizardSilent then
      MsgBox('Some parts could not be downloaded. LLM Icarus is installed; use "LLM Icarus - Download components" in the Start menu to retry, or Settings inside the app.', mbInformation, MB_OK);
  end;
end;

// Models and chats live in the install folder's data\ directory; ask before deleting them.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  DataDir := ExpandConstant('{app}\data');
  if DirExists(DataDir) then
  begin
    if UninstallSilent or (MsgBox('Also delete your downloaded models, Python tools, chats and generated files?' + #13#10 + DataDir + #13#10 + #13#10 + 'Choose No to keep them.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(DataDir, True, True, True);
  end;
  RemoveDir(ExpandConstant('{app}'));
end;
