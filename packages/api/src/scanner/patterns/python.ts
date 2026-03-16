/**
 * Python security patterns — for .py, .pyx, .pyi files.
 * Covers malware patterns common in PyPI supply-chain attacks.
 *
 * Worker-compatible: no fs, no child_process.
 */

import type { PatternDef } from '../core.js';

export const EXTENSIONS = new Set(['.py', '.pyx', '.pyi']);

export const PATTERNS: PatternDef[] = [
  // ── Critical: code execution ──
  { severity: 'critical', category: 'Code Execution', pattern: 'exec()',
    regex: /\bexec\s*\(/g,
    description: 'exec() — executes arbitrary Python code from strings' },
  { severity: 'critical', category: 'Code Execution', pattern: 'eval()',
    regex: /\beval\s*\(/g,
    description: 'eval() — evaluates arbitrary Python expressions' },
  { severity: 'critical', category: 'Code Execution', pattern: 'compile()',
    regex: /\bcompile\s*\([^)]*,\s*[^)]*,\s*['"]exec['"]/g,
    description: 'compile() with exec mode — compiles code for execution' },
  { severity: 'critical', category: 'Obfuscation', pattern: '__import__',
    regex: /__import__\s*\(/g,
    description: '__import__() — dynamic module import, common in obfuscated code' },
  { severity: 'critical', category: 'Obfuscation', pattern: 'marshal.loads',
    regex: /\bmarshal\.loads?\s*\(/g,
    description: 'marshal.loads() — deserializes bytecode, used to hide malicious code' },
  { severity: 'critical', category: 'Obfuscation', pattern: 'pickle.loads',
    regex: /\bpickle\.loads?\s*\(/g,
    description: 'pickle.loads() — deserializes objects, can execute arbitrary code' },

  // ── Critical: steganography / hidden code ──
  { severity: 'critical', category: 'Obfuscation', pattern: 'base64 decode + exec',
    regex: /base64\.b64decode\s*\([^)]*\).*exec|exec\s*\(.*base64\.b64decode/gs,
    description: 'Decodes base64 and executes — common malware pattern' },

  // ── High: shell execution ──
  { severity: 'high', category: 'Shell Execution', pattern: 'subprocess',
    regex: /\bsubprocess\.(?:call|run|Popen|check_output|check_call|getoutput)\s*\(/g,
    description: 'subprocess call — can execute shell commands' },
  { severity: 'high', category: 'Shell Execution', pattern: 'os.system',
    regex: /\bos\.system\s*\(/g,
    description: 'os.system() — executes shell commands' },
  { severity: 'high', category: 'Shell Execution', pattern: 'os.popen',
    regex: /\bos\.popen\s*\(/g,
    description: 'os.popen() — opens a pipe to a shell command' },
  { severity: 'high', category: 'Shell Execution', pattern: 'commands.getoutput',
    regex: /\bcommands\.getoutput\s*\(/g,
    description: 'commands.getoutput() — legacy shell execution' },

  // ── High: setup.py install-time dangers ──
  { severity: 'high', category: 'Install-time Execution', pattern: 'setup.py with os/subprocess',
    regex: /(?:import\s+(?:os|subprocess|shutil)|from\s+(?:os|subprocess|shutil)\s+import).*(?:setup\s*\(|cmdclass)/gs,
    description: 'setup.py imports system modules — code runs during pip install' },

  // ── High: destructive file ops ──
  { severity: 'high', category: 'Destructive File Operation', pattern: 'os.remove',
    regex: /\bos\.(?:remove|unlink)\s*\(/g,
    description: 'os.remove()/unlink() — deletes files' },
  { severity: 'high', category: 'Destructive File Operation', pattern: 'shutil.rmtree',
    regex: /\bshutil\.rmtree\s*\(/g,
    description: 'shutil.rmtree() — recursively deletes directories' },
  { severity: 'high', category: 'Destructive File Operation', pattern: 'os.chmod',
    regex: /\bos\.chmod\s*\(/g,
    description: 'os.chmod() — modifies file permissions' },

  // ── High: credential access ──
  { severity: 'high', category: 'Credential Exfiltration', pattern: 'env var in network call',
    regex: /(?:requests\.(?:get|post|put)|urllib\.request\.urlopen|httpx\.(?:get|post))\s*\([^)]*os\.environ/g,
    description: 'Environment variable passed into a network call — potential exfiltration' },

  // ── Medium ──
  { severity: 'medium', category: 'Environment Access', pattern: 'os.environ',
    regex: /\bos\.environ\b/g,
    description: 'Accesses environment variables — common for configuration' },
  { severity: 'medium', category: 'Network Call', pattern: 'requests/urllib',
    regex: /\b(?:requests\.(?:get|post|put|delete|patch|head)|urllib\.request\.urlopen)\s*\(/g,
    description: 'HTTP request — makes outbound network connections' },
  { severity: 'medium', category: 'Network Call', pattern: 'socket',
    regex: /\bsocket\.(?:socket|create_connection)\s*\(/g,
    description: 'Raw socket usage — opens network connections' },
  { severity: 'medium', category: 'Network Call', pattern: 'DNS/IP resolution',
    regex: /\bsocket\.getaddrinfo\s*\(|socket\.gethostbyname\s*\(/g,
    description: 'DNS resolution — may be used for data exfiltration via DNS' },
  { severity: 'medium', category: 'File System Read', pattern: 'open()',
    regex: /\bopen\s*\([^)]*['"][rwa]/g,
    description: 'File open — reads or writes files on disk' },
  { severity: 'medium', category: 'Crypto Usage', pattern: 'cryptography/hashlib',
    regex: /\b(?:from\s+cryptography|import\s+hashlib|from\s+Crypto)\b/g,
    description: 'Crypto library usage' },
];
