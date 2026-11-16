import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  desescaparMarkdown,
  limparMarkdownDaAula,
  obterHtmlMarkdownParseado,
  limparCacheMarkdown,
  markdownCache
} from "../utils/markdownParser.js";
import { obterTituloAula } from "../utils/domHelpers.js";

describe("Markdown Parser & LRU Cache Suite", () => {
  beforeEach(() => {
    limparCacheMarkdown();
  });

  it("deve remover frontmatter YAML do cabeçalho", () => {
    const md = `---
title: Aula 01
tags: [cálculo, limites]
date: 2026-03-01
---

# Introdução aos Limites
Texto explicativo aqui.`;

    const limpo = limparMarkdownDaAula(md);
    assert.ok(!limpo.includes("title: Aula 01"));
    assert.ok(limpo.startsWith("# Introdução aos Limites"));
  });

  it("deve remover referências residuais do Obsidian e wiki links", () => {
    const md = `# Título da Aula
Este é um texto com anexo ![[diagrama.png]] embutido.

---
### 📂 Arquivos & Referências
- [[arquivo1.pdf]]
- [[arquivo2.pdf]]`;

    const limpo = limparMarkdownDaAula(md);
    assert.ok(!limpo.includes("### 📂 Arquivos & Referências"));
    assert.ok(!limpo.includes("![[diagrama.png]]"));
    assert.ok(limpo.includes("Este é um texto com anexo  embutido."));
  });

  it("deve converter blocos de solução e explicação em tags <details>", () => {
    const md = `## 🕵️ Ver Solução e Explicação
🔽 **Clique para ver a Solução**
Esta é a resolução passo a passo do exercício.`;

    const limpo = limparMarkdownDaAula(md);
    assert.ok(limpo.includes("<details>"));
    assert.ok(limpo.includes("<summary>🕵️ Clique para ver a Solução e Explicação</summary>"));
    assert.ok(limpo.includes("Esta é a resolução passo a passo do exercício."));
    assert.ok(limpo.includes("</details>"));
  });

  it("deve converter checkboxes markdown em elementos de formulário", () => {
    const md = `- [ ] Revisar conceitos de matrizes
- [x] Resolver lista de exercícios 1`;

    const limpo = limparMarkdownDaAula(md);
    assert.ok(limpo.includes('<input type="checkbox"'));
    assert.ok(limpo.includes('<input type="checkbox" checked'));
    assert.ok(limpo.includes("line-through"));
  });

  it("deve utilizar e gerenciar o cache LRU ao parsear textos repetidos", () => {
    const md = "# Teste de Cache\nParágrafo de teste.";
    assert.equal(markdownCache.size, 0);

    const html1 = obterHtmlMarkdownParseado(md);
    assert.equal(markdownCache.size, 1);

    const html2 = obterHtmlMarkdownParseado(md);
    assert.equal(html1, html2);
    assert.equal(markdownCache.size, 1);
  });

  it("deve retornar mensagem padrão para texto nulo ou vazio", () => {
    const htmlNulo = obterHtmlMarkdownParseado(null);
    assert.ok(htmlNulo.includes("Texto Markdown vazio"));

    const htmlVazio = obterHtmlMarkdownParseado("   ");
    assert.ok(htmlVazio.includes("Texto Markdown vazio"));
  });

  it("deve inferir metadados e ícones corretos por extensão de arquivo", async () => {
    const { inferirMetaPorExtensao } = await import("../utils/markdownParser.js");
    assert.equal(inferirMetaPorExtensao("pdf").icone, "📄");
    assert.equal(inferirMetaPorExtensao("py").icone, "🐍");
    assert.equal(inferirMetaPorExtensao("m4a").icone, "🎧");
    assert.equal(inferirMetaPorExtensao("mp4").icone, "🎬");
    assert.equal(inferirMetaPorExtensao("ipynb").icone, "📓");
    assert.equal(inferirMetaPorExtensao("desconhecido").icone, "📎");
  });

  it("deve extrair com sucesso o Bloco 15 filtrando estritamente Material Bruto (PDFs com OCR, txts e códigos)", async () => {
    const { extrairBloco15Arquivos } = await import("../utils/markdownParser.js");

    const mdComBloco15 = `# Aula 01 - Big Data e Arquitetura Distribuída

Conteúdo da aula teórica...

### 📂 15. Arquivos e Referências
> Arquivos processados para esta aula:
- 📄 \`arquiv0_teoria_big_data.pdf\` (Slides teóricos da aula com OCR)
- 📊 [dataset_experimento.csv](https://drive.google.com/file/d/12345/view) - Base de dados de teste
- 🐍 \`script_spark.py\` (Código de demonstração do cluster)
- 🎧 \`podcast_revisao.m4a\` - Áudio de reprodução (PROIBIDO)
- 🎬 \`gravacao.mp4\` - Vídeo de aula (PROIBIDO)
- 🖼️ \`infografico.png\` - Imagem vertical (PROIBIDA)
---
`;

    const arquivosFisicos = [
      // Tolerância a erro: arquiv0_teoria -> arquivo_teoria
      { nome: "arquivo_teoria_big_data.pdf", tipo: "pdf", temOCR: true, driveId: "1abc_drive_id" },
      { nome: "script_spark.py", tipo: "py", driveId: "2def_drive_id" }
    ];

    const res = extrairBloco15Arquivos(mdComBloco15, arquivosFisicos);
    assert.equal(res.temBloco15, true);

    // Somente os 3 materiais brutos permitidos devem aparecer (o m4a, mp4 e png foram descartados)
    // E nem a linha "Arquivos processados..." nem a linha "---" devem virar card!
    assert.equal(res.arquivosReferenciados.length, 3);

    // Primeiro item: slides.pdf com match fuzzy tolerante a erro (0 -> o)
    const itemPdf = res.arquivosReferenciados[0];
    assert.equal(itemPdf.nome, "arquivo_teoria_big_data.pdf");
    assert.equal(itemPdf.ext, "pdf");
    assert.equal(itemPdf.icone, "📄");
    assert.equal(itemPdf.encontradoNoDb, true);
    assert.equal(itemPdf.arquivoDb.driveId, "1abc_drive_id");

    // Segundo item: dataset_experimento.csv com link markdown externo
    const itemCsv = res.arquivosReferenciados[1];
    assert.equal(itemCsv.nome, "dataset_experimento.csv");
    assert.equal(itemCsv.linkExterno, "https://drive.google.com/file/d/12345/view");

    // Terceiro item: script python
    const itemPy = res.arquivosReferenciados[2];
    assert.equal(itemPy.nome, "script_spark.py");
    assert.equal(itemPy.icone, "🐍");
  });

  it("deve aplicar a regra de Fallback Elegante filtrando apenas material bruto permitido", async () => {
    const { resolverInventarioArquivosAula } = await import("../utils/markdownParser.js");

    const aulaSemBloco15 = {
      id: "aula-sem-b15",
      nome: "Aula 02 - Sem Bloco 15",
      arquivos: [
        { nome: "slides_sem_ocr.pdf", tipo: "pdf", temOCR: false, driveId: "pdf-sem-ocr" }, // Proibido
        { nome: "aula_gravada.mp4", tipo: "mp4", driveId: "mp4-123" }, // Proibido
        { nome: "podcast.m4a", tipo: "m4a", driveId: "m4a-123" }, // Proibido
        { nome: "infografico.jpg", tipo: "jpg", driveId: "jpg-123" }, // Proibido
        { nome: "livro_teoria.pdf", tipo: "pdf", temOCR: true, driveId: "pdf-ocr-ok" }, // PERMITIDO
        { nome: "exercicios.py", tipo: "py", driveId: "py-123" }, // PERMITIDO
        { nome: "resumo.md", tipo: "md" } // PERMITIDO
      ]
    };

    const textoMdSimples = "# Apenas Resumo da Aula\nSem bloco 15 de referências.";
    const inventario = resolverInventarioArquivosAula(aulaSemBloco15, textoMdSimples);

    assert.equal(inventario.temBloco15, false);
    // Somente os 3 arquivos permitidos devem aparecer (PDF com OCR, script .py e resumo .md)
    assert.equal(inventario.totalArquivos, 3);
    assert.equal(inventario.arquivos.length, 3);
    assert.ok(inventario.arquivos.some(a => a.nome === "livro_teoria.pdf" && a.icone === "📄"));
    assert.ok(inventario.arquivos.some(a => a.nome === "exercicios.py" && a.icone === "🐍"));
    assert.ok(inventario.arquivos.some(a => a.nome === "resumo.md" && a.icone === "📝"));
  });

  it("deve desescapar sintaxe Markdown literal (\\#, \\*\\*, \\* \\[ ] e &#x20;)", () => {
    const mdEscapado = `\\# Aula 1 - Introdução à Big Data

\\### 📝 Resumo do Conteúdo

Texto com \\*\\*negrito\\*\\* e espaço&#x20;normal.

\\* \\[ ] Compreender os 3 Vs`;

    const limpo = limparMarkdownDaAula(mdEscapado);
    assert.ok(limpo.startsWith("# Aula 1 - Introdução à Big Data"));
    assert.ok(limpo.includes("### 📝 Resumo do Conteúdo"));
    assert.ok(limpo.includes("**negrito**"));
    assert.ok(!limpo.includes("&#x20;"));
    assert.ok(limpo.includes('<input type="checkbox"'));
  });

  it("deve preservar todo o conteúdo quando houver múltiplos separadores --- no meio da aula", () => {
    const mdComSeparadores = `# Aula 02 - Grafos

Seção inicial importante.

---

### 🔍 Tópico Intermediário
Conteúdo que ficaria entre dois separadores e NUNCA deve ser apagado.

---

### 🔗 Conexão com o Futuro
Parte final preservada.`;

    const limpo = limparMarkdownDaAula(mdComSeparadores);
    assert.ok(limpo.includes("Seção inicial importante."));
    assert.ok(limpo.includes("Conteúdo que ficaria entre dois separadores e NUNCA deve ser apagado."));
    assert.ok(limpo.includes("Parte final preservada."));
  });

  it("deve converter Ver Solução com blocos de código Python (# comentários) sem truncar o <details>", () => {
    const mdComCodigo = `## 🕵️ Ver Solução e Explicação

🔽 **Clique para ver a Solução**

\`\`\`python
# Comentário com cerquilha dentro do código não pode cortar o bloco
def soma(a, b):
    return a + b
\`\`\`

Explicação final após o código.

### 🔑 Palavras-Chave
- \`Função\`: Bloco reutilizável.`;

    const limpo = limparMarkdownDaAula(mdComCodigo);
    assert.ok(limpo.includes("<details><summary>🕵️ Clique para ver a Solução e Explicação</summary>"));
    assert.ok(limpo.includes("return a + b"));
    assert.ok(limpo.includes("Explicação final após o código."));
    assert.ok(limpo.includes("</details>"));
    assert.ok(limpo.includes("### 🔑 Palavras-Chave"));
  });

  it("deve limpar títulos de aula com \\# escapado e prefixo Aula de Conclusão", () => {
    const aulaEscapada = {
      nome: "Aula Conclusão",
      arquivos: [
        {
          nome: "conclusao.md",
          tipo: "md",
          conteudoTexto: "\\# Aula de Conclusão - A Arte da Arquitetura\n\nConteúdo final."
        }
      ]
    };

    const titulo = obterTituloAula(aulaEscapada);
    assert.equal(titulo, "A Arte da Arquitetura");
    assert.equal(desescaparMarkdown("\\# Título\\*\\*").trim(), "# Título**");
  });
});

