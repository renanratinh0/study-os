/**
 * Study OS V2 - Markdown Parser com Cache LRU
 * Otimizado para alta performance e zero reprocessamento de aulas longas.
 */

import { classificarArquivoArtefato } from "./artifactsClassifier.js";

class LRUCache {
  constructor(max = 200) {
    this.max = max;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, val);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

export const markdownCache = new LRUCache(200);

/**
 * Desescapa marcações Markdown literais (ex: \#, \*\*, \&, &#x20;)
 * geradas por exportadores como Notion/Google Docs para restaurar a formatação nativa.
 * @param {string} mdCru
 * @returns {string}
 */
export function desescaparMarkdown(mdCru) {
  if (!mdCru) return "";
  let t = String(mdCru).replace(/&#x20;/g, " ");
  if (/\\#/.test(t) || /\\\*\\\*/.test(t)) {
    t = t
      .replace(/^(\s*)((?:\\#){1,6})\s+/gm, (_, esp, hashes) => `${esp}${hashes.replace(/\\#/g, "#")} `)
      .replace(/\\\*\\\*/g, "**")
      .replace(/^(\s*)\\([*+-])\s+/gm, "$1$2 ")
      .replace(/^(\s*\d+)\\\.\s+/gm, "$1. ")
      .replace(/(\s)\\\*([^*\n]+)\\\*/g, "$1*$2*")
      .replace(/\\\[/g, "[")
      .replace(/\\\]/g, "]")
      .replace(/\\&/g, "&")
      .replace(/^(\s*)\\-\s+/gm, "$1- ");
  }
  return t;
}

/**
 * Limpa o texto Markdown da aula removendo frontmatter YAML, blocos de
 * anexos do Obsidian e formata soluções e checkboxes.
 * @param {string} mdCru
 * @returns {string}
 */
export function limparMarkdownDaAula(mdCru) {
  if (!mdCru) return "";
  let texto = desescaparMarkdown(mdCru);
  texto = texto.replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");

  // Remove bloco residual de referências do Obsidian
  texto = texto.replace(/\n---\s*\n#{1,4}\s*(?:📂\s*)?(?:15\.\s*)?Arquivos\s*(?:e|&)\s*Referências[\s\S]*$/i, "");
  texto = texto.replace(/\n#{1,4}\s*(?:📂\s*)?(?:15\.\s*)?Arquivos\s*(?:e|&)\s*Referências[\s\S]*$/i, "");
  texto = texto.replace(/!\[\[([^\]]+)\]\]/g, "");

  // Formata bloco de solução e explicação em <details> colapsável
  texto = texto.replace(
    /#{2,4}\s*🕵️?\s*Ver Solução e Explicação[^\n]*\n+(?:🔽\s*(?:\*\*)?Clique para ver (?:uma possível |a )?(?:Solução(?:\s+Lógica|\s*\([^)]*\))?|Lógica)(?:\*\*)?[ \t]*\r?\n*)?([\s\S]*?)(?=\n#{1,4}\s*(?:🔑|🔗|📚|📂|✅|(?:1[2-5]|[89])\.\s*|\*\*Palavras-Chave|Palavras-Chave|Conexão|Para Aprofundar|Arquivos|Checklist)|$)/gi,
    (match, conteudoSolucao) => {
      if (conteudoSolucao.includes("<details>")) return match;
      return `\n<details><summary>🕵️ Clique para ver a Solução e Explicação</summary>\n\n${conteudoSolucao.trim()}\n\n</details>\n`;
    }
  );

  // Formata checkboxes interativas
  texto = texto
    .replace(/^\s*[-*]?\s*\[\s\]\s+(.*)$/gm, '- <label class="inline-flex items-center gap-2 cursor-pointer"><input type="checkbox" class="rounded border-notion-border bg-notion-bg text-indigo-500 focus:ring-0" /> <span>$1</span></label>')
    .replace(/^\s*[-*]?\s*\[[xX]\]\s+(.*)$/gm, '- <label class="inline-flex items-center gap-2 cursor-pointer"><input type="checkbox" checked class="rounded border-notion-border bg-notion-bg text-indigo-500 focus:ring-0" /> <span class="line-through opacity-70">$1</span></label>');

  return texto.trim();
}

/**
 * Converte Markdown limpo para HTML utilizando Marked.js com cache LRU.
 * @param {string} textoCru
 * @returns {string}
 */
export function obterHtmlMarkdownParseado(textoCru) {
  if (!textoCru) return `<p class="text-notion-muted italic">Texto Markdown vazio.</p>`;
  const textoLimpo = limparMarkdownDaAula(textoCru);
  if (!textoLimpo) return `<p class="text-notion-muted italic">Texto Markdown vazio.</p>`;

  let cached = markdownCache.get(textoLimpo);
  if (cached) return cached;

  let htmlResult = "";
  if (typeof marked !== "undefined" && typeof marked.parse === "function") {
    htmlResult = marked.parse(textoLimpo);
  } else {
    // Fallback leve caso marked não esteja no escopo (ex: testes em Node)
    htmlResult = `<p>${textoLimpo.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br/>")}</p>`;
  }

  markdownCache.set(textoLimpo, htmlResult);
  return htmlResult;
}

export function limparCacheMarkdown() {
  markdownCache.clear();
}

/**
 * Detecta ícone e rótulo amigável com base na extensão do arquivo.
 * @param {string} ext
 * @returns {{ icone: string, rotulo: string }}
 */
export function inferirMetaPorExtensao(ext = "") {
  const e = String(ext).toLowerCase().replace(/^\./, "");
  switch (e) {
    case "pdf":
      return { icone: "📄", rotulo: "Documento PDF" };
    case "md":
    case "markdown":
      return { icone: "📝", rotulo: "Resumo Markdown" };
    case "mp4":
    case "mov":
    case "webm":
    case "mkv":
      return { icone: "🎬", rotulo: "Vídeo / Aula Gravada" };
    case "m4a":
    case "mp3":
    case "wav":
    case "aac":
      return { icone: "🎧", rotulo: "Áudio / Podcast" };
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
      return { icone: "🖼️", rotulo: "Imagem / Infográfico" };
    case "py":
      return { icone: "🐍", rotulo: "Código Python" };
    case "ipynb":
      return { icone: "📓", rotulo: "Jupyter Notebook" };
    case "sql":
      return { icone: "🗄️", rotulo: "Script SQL / Banco" };
    case "csv":
    case "json":
    case "xlsx":
    case "parquet":
      return { icone: "📊", rotulo: "Base de Dados" };
    case "zip":
    case "rar":
    case "7z":
      return { icone: "📦", rotulo: "Arquivo Compactado" };
    case "java":
    case "c":
    case "cpp":
    case "js":
    case "ts":
    case "html":
    case "css":
      return { icone: "💻", rotulo: "Código Fonte" };
    default:
      return { icone: "📎", rotulo: "Arquivo Anexo" };
  }
}

/**
 * Normaliza nome de arquivo para comparação resiliente a erros (tolerância a 0/o, 1/l, acentos e separadores).
 * @param {string} nome
 * @returns {string}
 */
export function normalizarNomeArquivoParaComparacao(nome) {
  if (!nome) return "";
  return String(nome)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/0/g, "o") // substitui 0 por o
    .replace(/1/g, "l") // substitui 1 por l
    .replace(/[_.\-\s]+/g, "") // remove separadores
    .trim();
}

/**
 * Calcula a similaridade entre duas strings (Dice coefficient + inclusão).
 * @param {string} str1
 * @param {string} str2
 * @returns {number}
 */
export function calcularSimilaridadeStrings(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;
  const s1 = String(str1);
  const s2 = String(str2);
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;

  const pares1 = new Set();
  for (let i = 0; i < s1.length - 1; i++) pares1.add(s1.slice(i, i + 2));
  let intersecao = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    if (pares1.has(s2.slice(i, i + 2))) intersecao++;
  }
  const total = (s1.length - 1) + (s2.length - 1);
  return total > 0 ? (2 * intersecao) / total : 0;
}

/**
 * Encontra arquivo físico correspondente na pasta da aula usando Fuzzy Matching tolerante a erros de digitação.
 * @param {string} nomeBuscado
 * @param {Array<object>} [arquivosFisicos=[]]
 * @returns {object | null}
 */
export function encontrarArquivoFisicoFuzzy(nomeBuscado, arquivosFisicos = []) {
  if (!nomeBuscado || !arquivosFisicos.length) return null;
  const buscadoLimpo = String(nomeBuscado).toLowerCase().trim();
  const extBuscada = (buscadoLimpo.split(".").pop() || "").toLowerCase();
  const normBuscado = normalizarNomeArquivoParaComparacao(buscadoLimpo);

  // 1. Match exato
  for (const af of arquivosFisicos) {
    const nomeAf = String(af.nome || "").toLowerCase().trim();
    if (nomeAf === buscadoLimpo) return af;
  }

  // 2. Match normalizado (tolerância a 0->o, 1->l, etc)
  for (const af of arquivosFisicos) {
    const normAf = normalizarNomeArquivoParaComparacao(af.nome);
    if (normAf === normBuscado) return af;
  }

  // 3. Match de inclusão com mesma extensão
  for (const af of arquivosFisicos) {
    const extAf = String(af.tipo || (af.nome || "").split(".").pop() || "").toLowerCase();
    if (extBuscada && extAf && extBuscada !== extAf) continue;
    const normAf = normalizarNomeArquivoParaComparacao(af.nome);
    if (normAf.includes(normBuscado) || normBuscado.includes(normAf)) {
      return af;
    }
  }

  // 4. Match por similaridade Dice > 0.7
  let melhorAf = null;
  let melhorScore = 0;
  for (const af of arquivosFisicos) {
    const extAf = String(af.tipo || (af.nome || "").split(".").pop() || "").toLowerCase();
    if (extBuscada && extAf && extBuscada !== extAf) continue;
    const score = calcularSimilaridadeStrings(normBuscado, normalizarNomeArquivoParaComparacao(af.nome));
    if (score > 0.7 && score > melhorScore) {
      melhorScore = score;
      melhorAf = af;
    }
  }

  return melhorAf;
}

/**
 * Regra de Filtro Estrito para Material Bruto:
 * Apenas PDF COM OCR, TXTs/MDs e CÓDIGOS FONTE / DADOS.
 * Proibido: MP4, M4A, JPG, PNG e PDFs sem OCR.
 * @param {string} ext
 * @param {object} [arqDb=null]
 * @returns {boolean}
 */
export function ehArquivoMaterialBrutoPermitido(ext = "", arqDb = null) {
  // Regra Crítica Nº 1: mapa-mental.json, flashcards.md, quiz.md e relatorio.md
  // pertencem às Camadas 6-9 e NUNCA devem entrar no Cofre Admin (Camada 11)
  if (arqDb && classificarArquivoArtefato(arqDb).ehNovoArtefato) {
    return false;
  }

  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  
  // Proibição expressa de mídias de aula e imagens
  const PROIBIDOS = new Set([
    "mp4", "mov", "webm", "mkv", "avi", "3gp",
    "m4a", "mp3", "wav", "aac", "ogg", "flac", "wma",
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico"
  ]);
  if (PROIBIDOS.has(e)) return false;

  // Se for PDF: se o banco expressamente disser que não tem OCR, é proibido
  if (e === "pdf") {
    if (arqDb && (arqDb.temOCR === false || arqDb.statusOCR === "sem_ocr")) {
      return false; // Slides ou PDFs sem OCR são proibidos no material bruto
    }
    return true; // PDF com OCR é permitido
  }

  // Whitelist de arquivos textuais e de código
  const PERMITIDOS = new Set([
    // Textos e notas
    "txt", "md", "markdown", "rst", "tex", "log",
    // Códigos fonte e scripts
    "py", "ipynb", "sql", "java", "c", "cpp", "h", "hpp", "cs", "js", "ts", "html", "css",
    "sh", "bash", "r", "go", "rs", "scala", "kt", "php", "rb", "dart", "swift",
    // Dados estruturados / datasets brutos
    "csv", "json", "parquet", "xlsx", "tsv", "xml", "yaml", "yml",
    // Arquivos compactados de projeto
    "zip", "rar", "7z", "tar", "gz"
  ]);

  return PERMITIDOS.has(e);
}

/**
 * Extrai o Bloco 15 de Arquivos e Referências de um texto Markdown da aula.
 * Aplica tolerância a erros e filtra estritamente Material Bruto (PDFs com OCR, txts e códigos).
 * Ignora separadores, títulos e mídias proibidas.
 * @param {string} mdCru
 * @param {Array<object>} [arquivosFisicos=[]]
 * @returns {{ temBloco15: boolean, tituloBloco: string, arquivosReferenciados: Array<object>, textoCruBloco: string }}
 */
export function extrairBloco15Arquivos(mdCru, arquivosFisicos = []) {
  if (!mdCru || typeof mdCru !== "string") {
    return {
      temBloco15: false,
      tituloBloco: "",
      arquivosReferenciados: [],
      textoCruBloco: ""
    };
  }

  const mdLimpo = desescaparMarkdown(mdCru);

  // Regex para localizar o início do Bloco 15
  const regexInicio = /(?:^|\n)(?:#{1,4}\s*(?:📂\s*)?(?:15\.\s*)?Arquivos\s*(?:e|&)\s*Referências[^\n]*|>\s*\*?\*?Arquivos\s+(?:utilizados|processados)[^:\n]*:?[^\n]*)/i;
  const matchInicio = mdLimpo.match(regexInicio);

  if (!matchInicio) {
    return {
      temBloco15: false,
      tituloBloco: "",
      arquivosReferenciados: [],
      textoCruBloco: ""
    };
  }

  const indexInicio = matchInicio.index !== undefined ? matchInicio.index : mdLimpo.indexOf(matchInicio[0]);
  const subTexto = mdLimpo.slice(indexInicio);

  const linhas = subTexto.split("\n");
  const linhasBloco = [];
  let cabecalhoEncontrado = "";

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (i === 0 || (!cabecalhoEncontrado && (linha.startsWith("#") || linha.includes("Arquivos")))) {
      cabecalhoEncontrado = linha.replace(/^#+\s*/, "").replace(/^>\s*/, "").trim();
      linhasBloco.push(linha);
      continue;
    }

    // Se encontrar outro cabeçalho principal de mesmo nível ou maior (exceto se for dentro do bloco)
    if (/^#{1,3}\s+[^\s]/.test(linha) && !linha.toLowerCase().includes("arquivos")) {
      break;
    }
    linhasBloco.push(linha);
  }

  const textoCruBloco = linhasBloco.join("\n").trim();
  const arquivosReferenciados = [];

  linhasBloco.forEach(linha => {
    const l = linha.trim();
    if (!l || l.startsWith("#")) return;

    // Descarta separadores e linhas não-arquivo
    if (/^[-*_]{3,}$/.test(l)) return;
    if (/^>\s*\*?\*?Arquivos\s+(?:utilizados|processados|referenciados)[^:\n]*:?$/i.test(l)) return;

    // Remove marcadores de lista (- , * , + , números) e citações
    const conteudoLinha = l.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s*/, "").trim();
    if (!conteudoLinha || /^[-*_]{3,}$/.test(conteudoLinha)) return;

    // Se for apenas uma frase terminando em ":" sem extensão nem crases, ignora
    if (conteudoLinha.endsWith(":") && !conteudoLinha.includes("`") && !conteudoLinha.includes(".")) {
      return;
    }

    let nomeArquivo = "";
    let descricao = "";
    let linkExterno = "";

    // 1. Caso link Markdown: [Nome](URL)
    const matchMdLink = conteudoLinha.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (matchMdLink) {
      nomeArquivo = matchMdLink[1].trim();
      linkExterno = matchMdLink[2].trim();
      descricao = conteudoLinha.replace(matchMdLink[0], "").replace(/^[-–—:]\s*/, "").trim();
    } else {
      // 2. Caso código inline com nome de arquivo: `arquivo.ext`
      const matchBacktick = conteudoLinha.match(/`([^`]+)`/);
      if (matchBacktick) {
        nomeArquivo = matchBacktick[1].trim();
        descricao = conteudoLinha.replace(matchBacktick[0], "").replace(/^[-–—:]\s*/, "").trim();
      } else {
        // 3. Caso wiki link: [[arquivo.ext]]
        const matchWiki = conteudoLinha.match(/\[\[([^\]]+)\]\]/);
        if (matchWiki) {
          nomeArquivo = matchWiki[1].trim();
          descricao = conteudoLinha.replace(matchWiki[0], "").replace(/^[-–—:]\s*/, "").trim();
        } else {
          // 4. Caso texto simples contendo extensão com ponto: arquivo.pdf - descrição
          const matchExtensao = conteudoLinha.match(/([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]{2,5})/);
          if (matchExtensao) {
            nomeArquivo = matchExtensao[1].trim();
            descricao = conteudoLinha.replace(matchExtensao[0], "").replace(/^[-–—:]\s*/, "").trim();
          } else {
            // Linha não contém arquivo válido, descarta para não gerar cards espúrios
            return;
          }
        }
      }
    }

    // Limpa emoji do início do nome se houver
    nomeArquivo = nomeArquivo.replace(/^[\p{Emoji}\s]+/u, "").trim();
    descricao = descricao.replace(/^\((.*)\)$/, "$1").trim();

    if (!nomeArquivo || nomeArquivo === "---") return;

    // Busca o arquivo físico no banco com tolerância a erros (fuzzy match)
    const arqDb = encontrarArquivoFisicoFuzzy(nomeArquivo, arquivosFisicos);
    const nomeFinal = arqDb ? arqDb.nome : nomeArquivo;
    const extMatch = nomeFinal.match(/\.([a-zA-Z0-9]{2,5})(?:$|\s)/);
    const ext = extMatch ? extMatch[1].toLowerCase() : (arqDb?.tipo || (nomeFinal.includes(".") ? nomeFinal.split(".").pop().toLowerCase() : ""));

    // FILTRO ESTRITO: Apenas PDF COM OCR, TXTs e CÓDIGOS FONTE / DADOS!
    // E nunca incluir os 4 novos artefatos (mapa-mental.json, flashcards.md, quiz.md, relatorio.md)
    if (!ehArquivoMaterialBrutoPermitido(ext, arqDb || { nome: nomeFinal })) {
      return;
    }

    const meta = inferirMetaPorExtensao(ext);

    arquivosReferenciados.push({
      nome: nomeFinal,
      ext: ext || (arqDb?.tipo || ""),
      icone: meta.icone,
      tipoRotulo: meta.rotulo,
      descricao: descricao || (arqDb ? `Material bruto catalogado na pasta da aula` : "Referência de aula"),
      linkExterno: linkExterno || "",
      encontradoNoDb: Boolean(arqDb),
      arquivoDb: arqDb || null
    });
  });

  return {
    temBloco15: arquivosReferenciados.length > 0 || textoCruBloco.length > 0,
    tituloBloco: cabecalhoEncontrado || "15. Arquivos e Referências",
    arquivosReferenciados,
    textoCruBloco
  };
}

/**
 * Monta o inventário unificado de arquivos de uma aula com fallback elegante.
 * Exibe estritamente Material Bruto (PDFs com OCR, txts e códigos).
 * @param {object} aula
 * @param {string} [textoMd=""]
 * @returns {{ temBloco15: boolean, titulo: string, arquivos: Array<object>, extrasSemBloco15: Array<object>, totalArquivos: number }}
 */
export function resolverInventarioArquivosAula(aula, textoMd = "") {
  const arqsFisicos = Array.isArray(aula?.arquivos) ? aula.arquivos : [];
  const parsedBloco = extrairBloco15Arquivos(textoMd, arqsFisicos);

  if (parsedBloco.temBloco15 && parsedBloco.arquivosReferenciados.length > 0) {
    // Identifica arquivos do banco que NÃO foram mencionados no Bloco 15 (e que sejam permitidos como material bruto)
    const nomesCitados = new Set(parsedBloco.arquivosReferenciados.map(r => normalizarNomeArquivoParaComparacao(r.nome)));
    const extras = arqsFisicos.filter(af => {
      const extAf = String(af.tipo || (af.nome || "").split(".").pop() || "").toLowerCase();
      if (!ehArquivoMaterialBrutoPermitido(extAf, af)) return false;
      const normAf = normalizarNomeArquivoParaComparacao(af.nome);
      return ![...nomesCitados].some(nc => normAf.includes(nc) || nc.includes(normAf));
    }).map(af => {
      const ext = String(af.tipo || af.nome.split(".").pop() || "").toLowerCase();
      const meta = inferirMetaPorExtensao(ext);
      return {
        nome: af.nome,
        ext,
        icone: meta.icone,
        tipoRotulo: meta.rotulo,
        descricao: "Material bruto detectado na pasta da aula",
        linkExterno: "",
        encontradoNoDb: true,
        arquivoDb: af
      };
    });

    return {
      temBloco15: true,
      titulo: parsedBloco.tituloBloco,
      arquivos: parsedBloco.arquivosReferenciados,
      extrasSemBloco15: extras,
      totalArquivos: parsedBloco.arquivosReferenciados.length + extras.length
    };
  }

  // 🛡️ REGRA DE FALLBACK ELEGANTE:
  // Se o Bloco 15 não foi preenchido, lista APENAS arquivos permitidos (PDF com OCR, TXTs, Códigos)
  const arquivosPermitidos = arqsFisicos.filter(af => {
    const ext = String(af.tipo || (af.nome || "").split(".").pop() || "").toLowerCase();
    return ehArquivoMaterialBrutoPermitido(ext, af);
  });

  const arquivosFallback = arquivosPermitidos.map(af => {
    const ext = String(af.tipo || (af.nome || "").split(".").pop() || "").toLowerCase();
    const meta = inferirMetaPorExtensao(ext);
    let detalhe = "Material bruto detectado na pasta";
    if (ext === "pdf") {
      detalhe = "PDF Teórico com OCR ativo";
    } else if (ext === "md" || ext === "txt") {
      detalhe = "Resumo ou texto fonte da aula";
    } else if (["py", "sql", "ipynb"].includes(ext)) {
      detalhe = "Código fonte / script da aula";
    } else if (["csv", "json", "parquet"].includes(ext)) {
      detalhe = "Base de dados bruta para prática";
    }

    return {
      nome: af.nome,
      ext,
      icone: meta.icone,
      tipoRotulo: meta.rotulo,
      descricao: detalhe,
      linkExterno: "",
      encontradoNoDb: true,
      arquivoDb: af
    };
  });

  return {
    temBloco15: false,
    titulo: "Material Bruto Detectado na Pasta da Aula",
    arquivos: arquivosFallback,
    extrasSemBloco15: [],
    totalArquivos: arquivosFallback.length
  };
}
