/**
 * monacoSetup.ts
 * 必须在任何 <Editor> 渲染之前作为 side-effect import。
 * - 用本地 bundle（而非 CDN）初始化 Monaco
 * - 注册 Solidity Monarch 高亮
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// ── 1. 告诉 Monaco 如何获取 Worker ───────────────────────────────────────────
// 我们只用 Monarch（主线程）做高亮，read-only 模式不需要真正的 language server。
// 返回一个空 blob worker 以消除 "Could not create web worker" 警告，
// 同时避免使用 Vite 专有的 ?worker 语法。
(window as unknown as Record<string, unknown>).MonacoEnvironment = {
  getWorker(_moduleId: unknown, _label: string): Worker {
    const blobUrl = URL.createObjectURL(
      new Blob(["self.onmessage=function(){}"], { type: "application/javascript" })
    );
    return new Worker(blobUrl);
  },
};

// ── 2. 告诉 @monaco-editor/react 使用本地 monaco 而非 CDN ──────────────────
// Tauri 离线运行，不能依赖 CDN
loader.config({ monaco });

// ── 3. Solidity Monarch 语法高亮 ──────────────────────────────────────────────
const SOL_LANG = "solidity";

// 避免重复注册（HMR 场景）
if (!monaco.languages.getLanguages().some((l) => l.id === SOL_LANG)) {
  monaco.languages.register({ id: SOL_LANG, extensions: [".sol"] });

  const keywords = [
    "pragma","solidity","import","from","as",
    "abstract","contract","interface","library",
    "is","using","for",
    "function","modifier","event","error","constructor","fallback","receive",
    "struct","enum","mapping",
    "storage","memory","calldata",
    "public","private","internal","external",
    "pure","view","payable","nonpayable",
    "virtual","override",
    "returns","return","emit","revert","require","assert",
    "if","else","while","do","break","continue",
    "new","delete","try","catch",
    "assembly","unchecked",
    "true","false",
    "wei","gwei","ether","seconds","minutes","hours","days","weeks",
    "indexed","anonymous","immutable","constant",
    "type","this","super","selfdestruct",
  ];

  const typeKeywords = [
    "address","bool","string","bytes","var",
    ...["","8","16","24","32","40","48","56","64","72","80","88","96",
        "104","112","120","128","136","144","152","160","168","176","184","192",
        "200","208","216","224","232","240","248","256"].map((n) => `int${n}`),
    ...["","8","16","24","32","40","48","56","64","72","80","88","96",
        "104","112","120","128","136","144","152","160","168","176","184","192",
        "200","208","216","224","232","240","248","256"].map((n) => `uint${n}`),
    ...Array.from({ length: 32 }, (_, i) => `bytes${i + 1}`),
    "fixed","ufixed",
  ];

  monaco.languages.setMonarchTokensProvider(SOL_LANG, {
    defaultToken: "",
    tokenPostfix: ".sol",
    keywords,
    typeKeywords,
    operators: [
      "=",">","<","!","~","?",":",
      "==","<=",">=","!=","&&","||","++","--",
      "+","-","*","/","&","|","^","%","<<",">>",">>>",
      "+=","-=","*=","/=","&=","|=","^=","%=","<<=",">>=",">>>=",
      "->","=>",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
      root: [
        // identifiers / keywords
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            "@typeKeywords": "type",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        }],
        { include: "@whitespace" },
        // hex literals
        [/0[xX][0-9a-fA-F_]+/, "number.hex"],
        // numbers
        [/\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?/, "number"],
        // operators
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        // brackets
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
        // strings
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string_d" }],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/'/, { token: "string.quote", bracket: "@open", next: "@string_s" }],
      ],
      string_d: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      string_s: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/\/\*/, "comment", "@block_comment"],
        [/\/\/.*$/, "comment"],
      ],
      block_comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  // 可选：自动补全关键字（即使 read-only 也会在 hover 时用到 token 类型）
  monaco.languages.setLanguageConfiguration(SOL_LANG, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });
}
