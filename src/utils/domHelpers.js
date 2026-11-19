/**
 * Study OS V2 - DOM Helpers & Formatting Utilities
 * Funções utilitárias puras para sanitização, manipulação de texto,
 * extração de metadados e notificações visuais (Toasts).
 */

import { classificarArquivoArtefato } from "./artifactsClassifier.js";

/**
 * Converte qualquer texto em um slug amigável para URLs e identificadores.
 * Remove acentos, caracteres especiais e converte espaços para hífens.
 * @param {string} texto
 * @returns {string}
 */
export function slugify(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Escapa caracteres HTML perigosos para prevenir ataques XSS.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Normaliza o caminho de um arquivo para ser usado como chave única de busca,
 * convertendo barras invertidas em barras normais, aplicando NFC e lowercase.
 * @param {string} caminho
 * @returns {string}
 */
export function normalizarCaminhoChave(caminho) {
  return String(caminho || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .normalize("NFC")
    .toLowerCase();
}

/**
 * Exibe uma notificação Toast animada na tela.
 * @param {string} titulo
 * @param {string} mensagem
 * @param {'success' | 'info' | 'error'} [tipo='success']
 */
export function mostrarToast(titulo, mensagem, tipo = "success") {
  if (typeof document === "undefined") return;
  const container = document.getElementById("toast-container");
  if (!container) return;

  const cores = {
    success: "border-emerald-500/40 bg-emerald-950/90 text-emerald-100",
    info: "border-indigo-500/40 bg-indigo-950/90 text-indigo-100",
    error: "border-rose-500/40 bg-rose-950/90 text-rose-100"
  };
  const icones = { success: "✅", info: "⚡", error: "⚠️" };

  const toast = document.createElement("div");
  toast.className = `toast-enter pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-2xl backdrop-blur-md ${cores[tipo] || cores.info}`;
  toast.innerHTML = `
    <span class="text-lg shrink-0 mt-0.5">${icones[tipo] || "✨"}</span>
    <div class="flex-1 min-w-0">
      <div class="text-xs font-bold">${escapeHtml(titulo)}</div>
      <div class="text-[11px] opacity-90 mt-0.5 leading-relaxed">${escapeHtml(mensagem)}</div>
    </div>
    <button class="text-xs opacity-60 hover:opacity-100 px-1 cursor-pointer" onclick="this.parentElement.remove()">✕</button>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 5000);
}

/**
 * Extrai o ícone emoji inicial e o nome limpo de uma disciplina.
 * @param {string} nomeCru
 * @returns {{ icone: string, nomeLimpo: string }}
 */
export function extrairIconeENome(nomeCru) {
  const str = String(nomeCru || "").trim();
  if (!str) return { icone: "📘", nomeLimpo: "Disciplina" };
  if (str.startsWith("C ")) return { icone: "⚙️", nomeLimpo: str };

  const matchEmoji = str.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\S)+\s+(.*)$/u);
  if (matchEmoji && !/^[A-Za-z0-9]/.test(matchEmoji[1])) {
    return { icone: matchEmoji[1].trim(), nomeLimpo: matchEmoji[2].trim() };
  }

  const matchColado = str.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})+(.*)$/u);
  if (matchColado && matchColado[2]) {
    return { icone: matchColado[1].trim(), nomeLimpo: matchColado[2].trim() };
  }

  return { icone: "📘", nomeLimpo: str };
}

/**
 * Normaliza uma tag individual padronizando nomes curtos/ambíguos
 * (ex: "D" -> "Bloco D", "705" -> "Sala 705", "Quinta feira" -> "Quinta", "Cursos" -> "Curso").
 * @param {string} tagRaw
 * @returns {string}
 */
export function normalizarTagIndividual(tagRaw) {
  const t = String(tagRaw || "").trim();
  if (!t) return "";

  const lower = t.toLowerCase();
  if (lower === "cursos" || lower === "curso") return "Curso";

  // Padroniza dias da semana
  if (/^segunda(?:-|\s+)?(?:feira)?$/i.test(t)) return "Segunda";
  if (/^ter[çc]a(?:-|\s+)?(?:feira)?$/i.test(t)) return "Terça";
  if (/^quarta(?:-|\s+)?(?:feira)?$/i.test(t)) return "Quarta";
  if (/^quinta(?:-|\s+)?(?:feira)?$/i.test(t)) return "Quinta";
  if (/^sexta(?:-|\s+)?(?:feira)?$/i.test(t)) return "Sexta";
  if (/^s[áa]bado$/i.test(t)) return "Sábado";

  // Padroniza blocos/prédios de letra única ou ALFA
  if (/^(?:[A-Z]|ALFA)$/i.test(t)) return `Bloco ${t.toUpperCase()}`;

  // Padroniza números de sala com 3 dígitos (ex: 705 -> Sala 705)
  if (/^\d{3}$/.test(t)) return `Sala ${t}`;

  return t;
}

/**
 * Converte tags brutas em lista de strings limpas, padronizadas e sem duplicatas.
 * @param {string | string[]} tagsRaw
 * @returns {string[]}
 */
export function parsearTagsDisciplina(tagsRaw) {
  if (!tagsRaw) return [];
  const lista = Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw).split(",");
  const vistas = new Set();
  const resultado = [];

  for (const item of lista) {
    const norm = normalizarTagIndividual(item);
    if (!norm) continue;
    const chave = norm.toLowerCase();
    if (!vistas.has(chave)) {
      vistas.add(chave);
      resultado.push(norm);
    }
  }
  return resultado;
}

/**
 * Normaliza o status da disciplina para um dos três estados do Notion.
 * @param {string} statusRaw
 * @returns {'Aprovado' | 'Em andamento' | 'DP'}
 */
export function normalizarStatusDisciplina(statusRaw) {
  const s = String(statusRaw || "").trim().toLowerCase();
  if (s.includes("aprovado") || s.includes("conclu")) return "Aprovado";
  if (s.includes("andamento") || s.includes("cursando")) return "Em andamento";
  if (s === "dp" || s.includes("depend") || s.includes("reprov")) return "DP";
  return "Em andamento";
}

/**
 * Normaliza o nome do professor, descartando placeholders.
 * @param {string} profRaw
 * @returns {string}
 */
export function normalizarProfessor(profRaw) {
  const p = String(profRaw || "").trim();
  if (!p || p.toLowerCase().includes("por favor digite") || p.toLowerCase() === "desconhecido" || p.toLowerCase() === "sem prof") {
    return "Professor a definir";
  }
  return p;
}

/**
 * Extrai o número da aula a partir do nome da pasta ou arquivo.
 * @param {string} nome
 * @returns {number | null}
 */
export function extrairNumeroAula(nome) {
  if (!nome) return null;
  const m = String(nome).match(/(?:aula|cap[ií]tulo)\s*0*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const m2 = String(nome).match(/\b0*(\d+)\b/);
  return m2 ? parseInt(m2[1], 10) : null;
}

/**
 * Remove prefixos redundantes de títulos como "Aula 01: ", "Aula 4 - ", etc.
 * @param {string} titulo
 * @returns {string}
 */
export function limparPrefixoAula(titulo) {
  if (!titulo) return "";
  let limpo = String(titulo).replace(/^(?:\\?#)+\s*/, "").trim();
  limpo = limpo.replace(/^(?:aula\s*\d+|aula\s*(?:de\s+)?conclus[aã]o|aula\s*(?:de\s+)?introdu[cç][aã]o|aula)\s*[-:–—|]\s*/i, "").trim();
  return limpo || titulo;
}

/**
 * Extrai e limpa o título principal (H1) de um texto Markdown, removendo YAML frontmatter
 * e prefixos redundantes ("Aula 01 - ", "Aula de Conclusão - ").
 * @param {string} texto
 * @returns {string}
 */
export function extrairTituloH1DeMarkdown(texto) {
  if (!texto) return "";
  const semYaml = String(texto).replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
  const linhas = semYaml.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const linhaH1 = linhas.find(l => /^(?:\\?#)+/.test(l)) || linhas[0];
  return linhaH1 ? limparPrefixoAula(linhaH1) : "";
}

/**
 * Obtém o melhor título H1 representativo para uma aula a partir do seu arquivo .md,
 * metadado `tituloH1`, nome do arquivo ou nome da pasta.
 * @param {object} aula
 * @param {Record<string, string>} [cacheMarkdownTexto={}]
 * @returns {string}
 */
export function obterTituloAula(aula, cacheMarkdownTexto = {}) {
  if (!aula) return "Aula";
  const arquivos = aula.arquivos || [];
  const mdArq = arquivos.find(a => {
    if (classificarArquivoArtefato(a).ehNovoArtefato) return false;
    const ext = String(a.tipo || (a.nome || "").split(".").pop() || "").toLowerCase();
    const cacheKey = a.id || a.local;
    return ext === "md" || ext === "markdown" || /\.(md|markdown)$/i.test(String(a.nome || "")) || a.conteudoTexto || a.tituloH1 || cacheMarkdownTexto[cacheKey];
  });

  if (mdArq) {
    const cacheKey = mdArq.id || mdArq.local;
    const textoDisponivel = cacheMarkdownTexto[cacheKey] ?? mdArq.conteudoTexto;
    if (textoDisponivel) {
      const limpo = extrairTituloH1DeMarkdown(textoDisponivel);
      if (limpo) return limpo;
    }
    const h1Salvo = mdArq.tituloH1 || aula.tituloH1;
    if (h1Salvo) {
      const limpoH1 = limparPrefixoAula(h1Salvo);
      if (limpoH1) return limpoH1;
    }
    if (mdArq.nome) {
      const nomeSemExt = mdArq.nome
        .replace(/\.(md|markdown|txt)$/i, "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const limpo = limparPrefixoAula(nomeSemExt);
      if (limpo) return limpo;
    }
  } else if (aula.tituloH1) {
    const limpoH1 = limparPrefixoAula(aula.tituloH1);
    if (limpoH1) return limpoH1;
  }

  return limparPrefixoAula(aula.nome || "Aula");
}
