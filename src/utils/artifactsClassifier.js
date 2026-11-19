/**
 * Study OS V2 - Artifacts Classifier (Regra Crítica Nº 1)
 * Isolamento estrito de novos artefatos (mapa-mental.json, flashcards.md, quiz.md, relatorio.md)
 * para nunca sobrescrever o Resumo Principal (Camada 1) nem vazar para o Cofre Admin (Camada 11).
 */

/**
 * Normaliza o nome base de um arquivo removendo acentos, espaços externos e convertendo para minúsculas.
 * @param {string} nomeArquivo
 * @returns {string}
 */
export function normalizarNomeArtefato(nomeArquivo) {
  const str = String(nomeArquivo || "").trim();
  if (!str) return "";
  const base = str.replace(/\\/g, "/").split("/").pop() || "";
  return base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Classifica um arquivo de aula com prioridade estrita por nome (case-insensitive):
 *  1. mapa-mental.json (ou *mapa-mental.json) -> 'mindmap' (nunca vai para datasets brutos da Camada 11)
 *  2. flashcards.md (ou *flashcards.md)       -> 'flashcards' (nunca sobrescreve Camada 1)
 *  3. quiz.md (ou *quiz.md)                   -> 'quiz' (nunca sobrescreve Camada 1)
 *  4. relatorio.md (ou *relatorio.md)         -> 'relatorio' (nunca abre no corpo nem sobrescreve Camada 1)
 *  5. qualquer outro .md / .markdown          -> 'md_principal' (Camada 1)
 *  6. demais arquivos                         -> 'outro'
 *
 * @param {string | { nome?: string, local?: string, artifactRole?: string, tipo?: string }} arquivoOuNome
 * @returns {{
 *   role: 'mindmap' | 'flashcards' | 'quiz' | 'relatorio' | 'md_principal' | 'outro',
 *   ehNovoArtefato: boolean,
 *   ehResumoPrincipalMd: boolean,
 *   bloqueadoCofreAdmin: boolean
 * }}
 */
export function classificarArquivoArtefato(arquivoOuNome) {
  if (!arquivoOuNome) {
    return { role: "outro", ehNovoArtefato: false, ehResumoPrincipalMd: false, bloqueadoCofreAdmin: false };
  }

  const obj = typeof arquivoOuNome === "object" ? arquivoOuNome : null;
  const roleExplicita = String(obj?.artifactRole || "").trim().toLowerCase();
  if (["mindmap", "flashcards", "quiz", "relatorio"].includes(roleExplicita)) {
    return {
      role: roleExplicita,
      ehNovoArtefato: true,
      ehResumoPrincipalMd: false,
      bloqueadoCofreAdmin: true
    };
  }

  const nomeBruto = typeof arquivoOuNome === "string"
    ? arquivoOuNome
    : (obj?.nome || obj?.local || "");
  const nomeNorm = normalizarNomeArtefato(nomeBruto);

  if (nomeNorm.endsWith("mapa-mental.json")) {
    return {
      role: "mindmap",
      ehNovoArtefato: true,
      ehResumoPrincipalMd: false,
      bloqueadoCofreAdmin: true
    };
  }

  if (nomeNorm.endsWith("flashcards.md")) {
    return {
      role: "flashcards",
      ehNovoArtefato: true,
      ehResumoPrincipalMd: false,
      bloqueadoCofreAdmin: true
    };
  }

  if (nomeNorm.endsWith("quiz.md")) {
    return {
      role: "quiz",
      ehNovoArtefato: true,
      ehResumoPrincipalMd: false,
      bloqueadoCofreAdmin: true
    };
  }

  if (nomeNorm.endsWith("relatorio.md")) {
    return {
      role: "relatorio",
      ehNovoArtefato: true,
      ehResumoPrincipalMd: false,
      bloqueadoCofreAdmin: true
    };
  }

  const ext = String(obj?.tipo || (nomeNorm.includes(".") ? nomeNorm.split(".").pop() : "")).toLowerCase();
  if (nomeNorm.endsWith(".md") || nomeNorm.endsWith(".markdown") || ext === "md" || ext === "markdown") {
    return {
      role: "md_principal",
      ehNovoArtefato: false,
      ehResumoPrincipalMd: true,
      bloqueadoCofreAdmin: false
    };
  }

  return {
    role: "outro",
    ehNovoArtefato: false,
    ehResumoPrincipalMd: false,
    bloqueadoCofreAdmin: false
  };
}

/**
 * Separa uma lista mista de arquivos de aula isolando os 4 novos artefatos
 * dos arquivos tradicionais (Camada 1 .md, mídias e Material Bruto da Camada 11).
 * @param {Array<object>} arquivos
 * @returns {{
 *   resumoMds: Array<object>,
 *   artifacts: { mindmap: object | null, flashcards: object | null, quiz: object | null, relatorio: object | null },
 *   outrosArquivos: Array<object>,
 *   arquivosTradicionais: Array<object>
 * }}
 */
export function separarArtefatosDaAula(arquivos = []) {
  const resumoMds = [];
  const outrosArquivos = [];
  const arquivosTradicionais = [];
  const artifacts = {
    mindmap: null,
    flashcards: null,
    quiz: null,
    relatorio: null
  };

  (Array.isArray(arquivos) ? arquivos : []).forEach(arq => {
    if (!arq) return;
    const classif = classificarArquivoArtefato(arq);

    if (classif.ehNovoArtefato) {
      if (!artifacts[classif.role]) {
        artifacts[classif.role] = { ...arq, artifactRole: classif.role };
      }
      return;
    }

    arquivosTradicionais.push(arq);
    if (classif.ehResumoPrincipalMd) {
      resumoMds.push(arq);
    } else {
      outrosArquivos.push(arq);
    }
  });

  return {
    resumoMds,
    artifacts,
    outrosArquivos,
    arquivosTradicionais
  };
}
