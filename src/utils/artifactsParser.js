/**
 * Study OS V2 - Pure Parsers for Interactive Artifacts (Camadas 6, 7 e 8)
 * Funções puras e determinísticas para parsing resiliente de:
 *  - Flashcards Markdown (./flashcards.md)
 *  - Quiz Markdown (./quiz.md)
 *  - Mapa Mental Hierárquico JSON (./mapa-mental.json)
 */

import { desescaparMarkdown } from "./markdownParser.js";

/**
 * Faz o parsing seguro de literais Python/JSON simples (`{...}`, `[...]`, `'...'`, `"..."`).
 * Usado para decodificar blocos `{'flashcardContentBlock': [...]}` exportados pelo `notebooklm-py`.
 * @param {string} src
 * @returns {any}
 */
function parsePythonOuJsonLiteral(src) {
  const s = String(src || "").trim();
  let i = 0;

  function pularEspacos() {
    while (i < s.length && /\s/.test(s[i])) i++;
  }

  function parseString() {
    const quote = s[i++];
    let out = "";
    while (i < s.length) {
      const ch = s[i++];
      if (ch === quote) return out;
      if (ch === "\\") {
        if (i >= s.length) break;
        const esc = s[i++];
        if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "\\" || esc === "'" || esc === '"') out += esc;
        else if (esc === "u" && i + 4 <= s.length) {
          const hex = s.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            out += "\\u";
          }
        } else if (esc === "x" && i + 2 <= s.length) {
          const hex = s.slice(i, i + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
          } else {
            out += "\\x";
          }
        } else {
          out += `\\${esc}`;
        }
      } else {
        out += ch;
      }
    }
    throw new Error("String não terminada");
  }

  function parseArray() {
    i++; // [
    const arr = [];
    pularEspacos();
    while (i < s.length && s[i] !== "]") {
      arr.push(parseValue());
      pularEspacos();
      if (s[i] === ",") {
        i++;
        pularEspacos();
      } else {
        break;
      }
    }
    if (s[i] === "]") i++;
    return arr;
  }

  function parseObject() {
    i++; // {
    const obj = {};
    pularEspacos();
    while (i < s.length && s[i] !== "}") {
      const chave = parseValue();
      pularEspacos();
      if (s[i] !== ":") throw new Error("Esperado ':'");
      i++;
      const val = parseValue();
      obj[String(chave)] = val;
      pularEspacos();
      if (s[i] === ",") {
        i++;
        pularEspacos();
      } else {
        break;
      }
    }
    if (s[i] === "}") i++;
    return obj;
  }

  function parseValue() {
    pularEspacos();
    const ch = s[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === "'" || ch === '"') return parseString();

    const resto = s.slice(i);
    if (/^(?:True|true)\b/.test(resto)) {
      i += 4;
      return true;
    }
    if (/^(?:False|false)\b/.test(resto)) {
      i += 5;
      return false;
    }
    if (/^(?:None|null)\b/.test(resto)) {
      i += 4;
      return null;
    }
    const mNum = resto.match(/^-?\d+(?:\.\d+)?/);
    if (mNum) {
      i += mNum[0].length;
      return Number(mNum[0]);
    }
    throw new Error(`Token inesperado em '${resto.slice(0, 12)}'`);
  }

  return parseValue();
}

/**
 * Extrai texto legível de wrappers `{'flashcardContentBlock': [...]}` emitidos pelo `notebooklm-py`.
 * @param {string} raw
 * @returns {string}
 */
export function extrairTextoFlashcardBlock(raw) {
  const txt = String(raw || "").trim();
  if (!txt || !txt.includes("flashcardContentBlock")) return txt;

  const tentarExtrairObj = (candidato) => {
    try {
      const obj = candidato.startsWith('{"')
        ? JSON.parse(candidato)
        : parsePythonOuJsonLiteral(candidato);
      const blocos = obj?.flashcardContentBlock;
      if (!Array.isArray(blocos)) return null;
      const partes = [];
      for (const b of blocos) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && b.content) {
          partes.push(String(b.content).trim());
        } else if (b.type === "image" && b.alt) {
          partes.push(`[Imagem: ${String(b.alt).trim()}]`);
        } else if (b.content) {
          partes.push(String(b.content).trim());
        }
      }
      const combinado = partes.filter(Boolean).join("\n").trim();
      return combinado || null;
    } catch (_) {
      return null;
    }
  };

  if (txt.startsWith("{")) {
    const extraido = tentarExtrairObj(txt);
    if (extraido) return extraido;
  }

  return txt
    .split("\n")
    .map(linha => {
      const t = linha.trim();
      if (t.startsWith("{") && t.includes("flashcardContentBlock")) {
        return tentarExtrairObj(t) || linha;
      }
      return linha;
    })
    .join("\n")
    .trim();
}

/**
 * Limpa prefixos/separadores residuais de blocos Markdown capturados.
 * @param {string} texto
 * @returns {string}
 */
function limparTextoBloco(texto) {
  const limpo = String(texto || "")
    .replace(/\r?\n\s*[-*_]{3,}\s*$/g, "")
    .replace(/^\s*[-*_]{3,}\s*\r?\n/g, "")
    .trim();
  return extrairTextoFlashcardBlock(limpo);
}

/**
 * Faz o parsing resiliente de um arquivo `flashcards.md`.
 * Extrai blocos divididos por `## Card \d+`, capturando `**Q:**` e `**A:**`,
 * ignorando linhas em branco extras, separadores `---` e escapes literais.
 *
 * @param {string} md
 * @returns {Array<{ id: string, number: number, question: string, answer: string }>}
 */
export function parseFlashcardsMarkdown(md) {
  if (!md || typeof md !== "string") return [];

  const normalizado = desescaparMarkdown(md)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");

  const headerRegex = /^#{2,4}\s*Card\s+(\d+)(?:[^\n]*)$/gim;
  const matches = [...normalizado.matchAll(headerRegex)];
  if (matches.length === 0) return [];

  const cards = [];
  for (let i = 0; i < matches.length; i++) {
    const atual = matches[i];
    const numero = parseInt(atual[1], 10);
    const inicioCorpo = atual.index + atual[0].length;
    const fimCorpo = i + 1 < matches.length ? matches[i + 1].index : normalizado.length;
    const bloco = normalizado.slice(inicioCorpo, fimCorpo);

    // Captura **Q:** ... **A:** ... (tolerando **Q**: / Q: e **A**: / A: ou P:/R:)
    const matchQA = bloco.match(
      /(?:^|\n)\s*(?:\*\*Q:\*\*|\*\*Q\*\*:|Q:|\*\*P:\*\*|\*\*P\*\*:)\s*([\s\S]*?)\n+\s*(?:\*\*A:\*\*|\*\*A\*\*:|A:|\*\*R:\*\*|\*\*R\*\*:)\s*([\s\S]*)$/i
    );

    if (!matchQA) continue;

    const question = limparTextoBloco(matchQA[1]);
    const answer = limparTextoBloco(matchQA[2]);

    if (question && answer) {
      cards.push({
        id: `card-${numero}`,
        number: numero,
        question,
        answer
      });
    }
  }

  return cards;
}

/**
 * Faz o parsing resiliente de um arquivo `quiz.md`.
 * Divide por `## Question \d+`, extrai o enunciado, as alternativas
 * `- [ ]` (correct: false) e `- [x]` (correct: true), e a linha `**Hint:**`.
 *
 * @param {string} md
 * @returns {Array<{
 *   id: string,
 *   number: number,
 *   prompt: string,
 *   options: Array<{ id: string, index: number, letter: string, text: string, correct: boolean }>,
 *   correctIndex: number,
 *   hint: string
 * }>}
 */
export function parseQuizMarkdown(md) {
  if (!md || typeof md !== "string") return [];

  const normalizado = desescaparMarkdown(md)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");

  const headerRegex = /^#{2,4}\s*(?:Question|Quest[aã]o)\s+(\d+)(?:[^\n]*)$/gim;
  const matches = [...normalizado.matchAll(headerRegex)];
  if (matches.length === 0) return [];

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const questions = [];

  for (let i = 0; i < matches.length; i++) {
    const atual = matches[i];
    const numero = parseInt(atual[1], 10);
    const inicioCorpo = atual.index + atual[0].length;
    const fimCorpo = i + 1 < matches.length ? matches[i + 1].index : normalizado.length;
    const bloco = normalizado.slice(inicioCorpo, fimCorpo);

    const linhas = bloco.split("\n");
    const promptLines = [];
    const options = [];
    const hintLines = [];
    let fase = "prompt"; // 'prompt' | 'options' | 'hint'

    for (const linha of linhas) {
      const trim = linha.trim();

      // Ignora separadores horizontais isolados
      if (/^[-*_]{3,}$/.test(trim)) continue;

      const matchOption = linha.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.+)$/);
      if (matchOption) {
        fase = "options";
        const idxOpt = options.length;
        options.push({
          id: `q${numero}-opt-${idxOpt}`,
          index: idxOpt,
          letter: letters[idxOpt] || String(idxOpt + 1),
          text: matchOption[2].trim(),
          correct: matchOption[1].toLowerCase() === "x"
        });
        continue;
      }

      const matchHint = trim.match(/^(?:\*\*Hint:\*\*|\*\*Hint\*\*:|Hint:|\*\*Dica:\*\*|\*\*Dica\*\*:|Dica:)\s*(.*)$/i);
      if (matchHint) {
        fase = "hint";
        if (matchHint[1]) hintLines.push(matchHint[1].trim());
        continue;
      }

      if (fase === "prompt") {
        promptLines.push(linha);
      } else if (fase === "hint" && trim) {
        hintLines.push(trim);
      }
    }

    const prompt = limparTextoBloco(promptLines.join("\n"));
    const hint = limparTextoBloco(hintLines.join(" "));
    const correctIndex = options.findIndex(o => o.correct);

    if (prompt && options.length > 0) {
      questions.push({
        id: `question-${numero}`,
        number: numero,
        prompt,
        options,
        correctIndex,
        hint
      });
    }
  }

  return questions;
}

/**
 * Normaliza uma árvore JSON recursiva `{ name, children }` para uso em grafos neurais
 * e inspeção estruturada. Calcula níveis, ramos herdados (`branchIndex`), ancestrais,
 * descendentes e lista plana de nós e arestas.
 *
 * @param {string | object} json
 * @returns {{
 *   root: object | null,
 *   nodes: Array<object>,
 *   edges: Array<{ id: string, sourceId: string, targetId: string, branchIndex: number }>,
 *   nodeMap: Record<string, object>,
 *   maxDepth: number,
 *   totalNodes: number
 * }}
 */
export function normalizeMindmapTree(json) {
  const vazio = {
    root: null,
    nodes: [],
    edges: [],
    nodeMap: {},
    maxDepth: 0,
    totalNodes: 0
  };

  if (!json) return vazio;

  let bruto = json;
  if (typeof bruto === "string") {
    try {
      bruto = JSON.parse(bruto);
    } catch (_) {
      return vazio;
    }
  }

  if (bruto && typeof bruto === "object" && !bruto.name && bruto.root && typeof bruto.root === "object") {
    bruto = bruto.root;
  }

  if (!bruto || typeof bruto !== "object") return vazio;

  const rootName = String(bruto.name ?? bruto.label ?? bruto.title ?? "").trim();
  if (!rootName) return vazio;

  const nodes = [];
  const edges = [];
  const nodeMap = {};
  let counter = 0;
  let maxDepth = 0;

  function traverse(rawNode, level, parentId, branchIndex, ancestorIds, path) {
    const id = `node-${counter++}`;
    const name = String(rawNode?.name ?? rawNode?.label ?? rawNode?.title ?? "Conceito").trim() || "Conceito";
    const currentPath = [...path, name];
    const currentAncestors = [...ancestorIds];

    if (level > maxDepth) maxDepth = level;

    const rawChildren = Array.isArray(rawNode?.children) ? rawNode.children : [];
    const normalizedNode = {
      id,
      name,
      level,
      branchIndex,
      parentId,
      childrenIds: [],
      ancestorIds: currentAncestors,
      descendantIds: [],
      path: currentPath,
      hasChildren: rawChildren.length > 0,
      leafCount: 0,
      children: []
    };

    nodes.push(normalizedNode);
    nodeMap[id] = normalizedNode;

    if (parentId) {
      edges.push({
        id: `${parentId}->${id}`,
        sourceId: parentId,
        targetId: id,
        branchIndex
      });
    }

    let leafAcc = 0;
    const nextAncestors = [...currentAncestors, id];

    rawChildren.forEach((childRaw, idxChild) => {
      if (!childRaw || typeof childRaw !== "object") return;
      const childBranchIndex = level === 0 ? idxChild : branchIndex;
      const childNorm = traverse(childRaw, level + 1, id, childBranchIndex, nextAncestors, currentPath);
      normalizedNode.children.push(childNorm);
      normalizedNode.childrenIds.push(childNorm.id);
      normalizedNode.descendantIds.push(childNorm.id, ...childNorm.descendantIds);
      leafAcc += childNorm.leafCount;
    });

    normalizedNode.hasChildren = normalizedNode.children.length > 0;
    normalizedNode.leafCount = normalizedNode.hasChildren ? leafAcc : 1;

    return normalizedNode;
  }

  const root = traverse(bruto, 0, null, -1, [], []);

  return {
    root,
    nodes,
    edges,
    nodeMap,
    maxDepth,
    totalNodes: nodes.length
  };
}
