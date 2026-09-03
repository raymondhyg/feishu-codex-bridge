(function () {
  "use strict";

  var shell = new ActiveXObject("WScript.Shell");
  var fileSystem = new ActiveXObject("Scripting.FileSystemObject");
  var scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName);
  var startScript = fileSystem.BuildPath(scriptDirectory, "start-bridge.ps1");

  if (!fileSystem.FileExists(startScript)) {
    WScript.Quit(2);
  }

  var powershellPath =
    shell.ExpandEnvironmentStrings("%SystemRoot%") +
    "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  var command =
    '"' +
    powershellPath +
    '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass' +
    ' -WindowStyle Hidden -File "' +
    startScript +
    '" -Foreground';

  var exitCode = shell.Run(command, 0, true);
  WScript.Quit(exitCode);
})();
