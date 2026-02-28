import { spawnSync } from "child_process";
import fs from "fs";

function normalizeResult(result) {
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout || "", stderr: result.stderr || "" };
  }
  return { ok: true, stdout: result.stdout || "", stderr: "" };
}

function runCommand(cmd, args) {
  const direct = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  const normalizedDirect = normalizeResult(direct);
  if (normalizedDirect.ok) {
    return normalizedDirect;
  }

  // On some Windows setups, direct spawn can fail with EPERM for binaries
  // installed via package managers, while invoking via shell still works.
  if (process.platform === "win32" && direct.error?.code === "EPERM") {
    const viaShell = spawnSync(cmd, args, {
      encoding: "utf8",
      windowsHide: true,
      shell: true,
    });
    return normalizeResult(viaShell);
  }

  return normalizedDirect;
}

function extractWithPdfToText(filePath) {
  return runCommand("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"]);
}

function extractWithPythonPypdf(filePath) {
  const py = [
    "import sys",
    "from pypdf import PdfReader",
    "p=sys.argv[1]",
    "r=PdfReader(p)",
    "out=[]",
    "for page in r.pages:",
    "  out.append(page.extract_text() or '')",
    "print('\\n\\n'.join(out))",
  ].join(";");
  return runCommand("python", ["-c", py, filePath]);
}

export function extractPdfText(filePath) {
  const sidecarPath = `${filePath}.sidecar`;
  if (fs.existsSync(sidecarPath)) {
    const text = fs.readFileSync(sidecarPath, "utf8");
    if (text.trim()) {
      return text;
    }
  }

  const attempt1 = extractWithPdfToText(filePath);
  if (attempt1.ok && attempt1.stdout.trim()) {
    return attempt1.stdout;
  }

  const attempt2 = extractWithPythonPypdf(filePath);
  if (attempt2.ok && attempt2.stdout.trim()) {
    return attempt2.stdout;
  }

  throw new Error(
    [
      `Unable to parse PDF directly: ${filePath}`,
      "Install one of:",
      "1) Poppler pdftotext (recommended), or",
      "2) Python package pypdf",
      "3) Or create a UTF-8 sidecar text file at <file>.pdf.sidecar",
      "Then rerun ingestion.",
    ].join("\n")
  );
}
