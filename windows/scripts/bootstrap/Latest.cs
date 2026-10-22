// Windows .NET Framework bootstrapper. Never executes downloaded scripts.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Latest {
    const string Repo = "https://github.com/kuzeyalpyildiz/coucou-custom/releases/download/";
    static string Asset(Dictionary<string, object> asset) {
        string url = (string)asset["browser_download_url"];
        if (!url.StartsWith(Repo, StringComparison.Ordinal) || new Uri(url).Scheme != "https")
            throw new Exception("Unexpected release asset URL.");
        return url;
    }
    [STAThread]
    static int Main() {
        string folder = null;
        try {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (var client = new WebClient()) {
                client.Headers["User-Agent"] = "Coucou-Latest-Installer";
                var release = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    client.DownloadString("https://api.github.com/repos/kuzeyalpyildiz/coucou-custom/releases/latest"));
                var installers = new List<Dictionary<string, object>>();
                Dictionary<string, object> checksums = null;
                foreach (Dictionary<string, object> asset in (IEnumerable)release["assets"]) {
                    string name = (string)asset["name"];
                    if (name == "SHA256SUMS.txt") checksums = asset;
                    // This distribution builds x64 Windows MSIs. Avoid ambiguous aliases.
                    if (name.EndsWith("_x64_en-US.msi", StringComparison.OrdinalIgnoreCase)) installers.Add(asset);
                }
                if (installers.Count != 1 || checksums == null)
                    throw new Exception("The latest stable release must contain one x64 en-US MSI and SHA256SUMS.txt.");
                var msi = installers[0];
                string filename = (string)msi["name"];
                string manifest = client.DownloadString(Asset(checksums));
                string expected = null;
                foreach (string line in manifest.Split('\n')) {
                    var match = Regex.Match(line.Trim(), @"^([a-fA-F0-9]{64})\s+\*?(.+)$");
                    if (match.Success && match.Groups[2].Value == filename) {
                        if (expected != null) throw new Exception("Duplicate installer checksum.");
                        expected = match.Groups[1].Value;
                    }
                }
                if (expected == null) throw new Exception("Installer checksum missing.");
                if (MessageBox.Show("Download and install Coucou " + (string)release["tag_name"] +
                    " from GitHub? Please quit Coucou before continuing.", "Coucou setup",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
                folder = Path.Combine(Path.GetTempPath(), "coucou-setup-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(folder);
                string path = Path.Combine(folder, "Coucou.msi");
                client.DownloadFile(Asset(msi), path);
                string actual;
                using (var sha = SHA256.Create())
                using (var stream = File.OpenRead(path)) actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
                if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase)) throw new Exception("Checksum mismatch. Installation cancelled.");
                var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), "/i \"" + path + "\"");
                start.UseShellExecute = true;
                using (var process = Process.Start(start)) {
                    process.WaitForExit();
                    if (process.ExitCode != 0 && process.ExitCode != 3010)
                        throw new Exception("Windows Installer returned " + process.ExitCode + ".");
                    return process.ExitCode;
                }
            }
        } catch (Exception error) {
            MessageBox.Show("Could not install the latest Coucou. No older fallback was installed.\n\n" + error.Message,
                "Coucou setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        } finally {
            if (folder != null) { try { Directory.Delete(folder, true); } catch { } }
        }
    }
}
