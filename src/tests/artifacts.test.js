import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlashcardsMarkdown,
  parseQuizMarkdown,
  normalizeMindmapTree,
  extrairTextoFlashcardBlock
} from "../utils/artifactsParser.js";
import {
  classificarArquivoArtefato,
  separarArtefatosDaAula
} from "../utils/artifactsClassifier.js";
import { resolverArtefatosAula } from "../services/mediaResolver.js";
import { normalizarDb } from "../core/store.js";
import {
  ehArquivoMaterialBrutoPermitido,
  resolverInventarioArquivosAula
} from "../utils/markdownParser.js";
import { obterTituloAula } from "../utils/domHelpers.js";
import {
  obterProgressoFlashcards,
  salvarAvaliacaoFlashcard,
  limparProgressoFlashcards,
  obterProgressoQuiz,
  salvarProgressoQuiz,
  limparProgressoQuiz
} from "../services/storage.js";
import { autenticarAdmin, desautenticarAdmin } from "../services/auth.js";
import { montarConteudoInternoDaAula } from "../components/LessonAccordion.js";
import {
  calcularVisibilidadeArvore,
  recolherUmNivelGlobal,
  expandirUmNivelGlobal,
  renderMindmapSectionHtml
} from "../components/NeuralMindmapCanvas.js";
import { renderFlashcardsSectionHtml } from "../components/FlashcardsDeck.js";
import { renderQuizSectionHtml } from "../components/QuizSimulator.js";
import { store } from "../core/store.js";
import { Modals } from "../main.js";

const MOCK_MINDMAP_JSON = {
  name: "Gestão de Operações",
  children: [
    {
      name: "Modelo de Transformação",
      children: [
        {
          name: "Inputs e Processos",
          children: [
            { name: "Recursos Transformadores" },
            { name: "Recursos a Serem Transformados" }
          ]
        },
        { name: "Outputs de Valor" }
      ]
    },
    {
      name: "Os 4 Vs da Produção",
      children: [
        { name: "Volume" },
        { name: "Variedade" },
        { name: "Variação da Demanda" },
        { name: "Visibilidade" }
      ]
    },
    {
      name: "Objetivos de Desempenho",
      children: [
        { name: "Qualidade & Rapidez" },
        { name: "Confiabilidade, Flexibilidade e Custo" }
      ]
    },
    {
      name: "Estratégia de Produção",
      children: [
        { name: "Trade-offs Operacionais" }
      ]
    }
  ]
};

const MOCK_FLASHCARDS_MD = `# Operações Flashcards

## Card 1

**Q:** Qual é o 'coração pulsante' encontrado no centro de qualquer organização, seja um hospital, fábrica ou empresa de software?

**A:** O Processo de Transformação (Input → Processo → Output).

---

## Card 2

**Q:** Quais são os três componentes fundamentais do Modelo de Transformação em um sistema de produção?

**A:** Entradas (Inputs), Processo de Transformação e Saídas (Outputs).

---

## Card 3

**Q:** Quais são os 4 Vs utilizados para caracterizar processos produtivos?

**A:** Volume, Variedade, Variação da Demanda e Visibilidade.

---

## Card 4

**Q:** Quais são os cinco objetivos de desempenho da função produção?

**A:** Qualidade, Rapidez, Confiabilidade, Flexibilidade e Custo.

---
`;

const MOCK_QUIZ_MD = `# Operações Questionário

## Question 1
Um hospital decide implementar um novo sistema onde os familiares podem acompanhar em tempo real, por um aplicativo, cada etapa do atendimento de um paciente na emergência. Qual dos 4 Vs da produção é mais diretamente impactado por essa mudança, e qual a consequência mais provável nos custos operacionais?

- [ ] Volume; os custos diminuem devido à maior eficiência na comunicação.
- [x] Visibilidade; os custos tendem a aumentar para garantir que o processo exposto seja impecável.
- [ ] Variedade; os custos tendem a aumentar para oferecer mais tipos de acompanhamento.
- [ ] Variação da Demanda; os custos diminuem, pois o aplicativo ajuda a prever os picos de atendimento.

**Hint:** Pense em qual dimensão se refere ao quanto o cliente pode observar o processo produtivo enquanto ele acontece.

## Question 2
Ao estruturar uma fábrica sob medida para automóveis de luxo com alta flexibilidade de configuração, qual trade-off tende a ocorrer?

- [ ] Redução imediata de tempo de setup sem impacto no orçamento.
- [x] Aumento de custo unitário em troca de maior flexibilidade e personalização.
- [ ] Eliminação total da necessidade de controle de qualidade.
- [ ] Aumento automático de economia de escala em linha rígida.

**Hint:** Lembre-se da regra do cobertor curto entre flexibilidade extrema e custo baixo.
`;

const MOCK_RELATORIO_MD = `# Relatório Técnico: Fundamentos da Gestão de Operações

## Executive Summary

Este relatório estabelece um framework técnico sobre processos de transformação, os 4 Vs da produção e o alinhamento entre objetivos de desempenho.
`;

describe("New Artifacts (Layers 6-11) Classification, Parsers & Persistence Suite", () => {
  beforeEach(() => {
    desautenticarAdmin();
  });

  afterEach(() => {
    desautenticarAdmin();
  });

  it("deve classificar os 4 novos artefatos por prioridade estrita (case-insensitive) e isolá-los da Camada 1 e Camada 11", () => {
    assert.equal(classificarArquivoArtefato("mapa-mental.json").role, "mindmap");
    assert.equal(classificarArquivoArtefato("Aula 01 - MAPA-MENTAL.JSON").role, "mindmap");
    assert.equal(classificarArquivoArtefato("flashcards.md").role, "flashcards");
    assert.equal(classificarArquivoArtefato("Operacoes_Flashcards.MD").role, "flashcards");
    assert.equal(classificarArquivoArtefato("quiz.md").role, "quiz");
    assert.equal(classificarArquivoArtefato("Aula02-QUIZ.md").role, "quiz");
    assert.equal(classificarArquivoArtefato("relatorio.md").role, "relatorio");
    assert.equal(classificarArquivoArtefato("Aula_Relatório.MD").role, "relatorio");
    assert.equal(classificarArquivoArtefato("Aula 01 - Processos Produtivos.md").role, "md_principal");
    assert.equal(classificarArquivoArtefato("dataset_bruto.json").role, "outro");

    const arquivosMistos = [
      { nome: "flashcards.md", tipo: "md", conteudoTexto: MOCK_FLASHCARDS_MD },
      { nome: "quiz.md", tipo: "md", conteudoTexto: MOCK_QUIZ_MD },
      { nome: "relatorio.md", tipo: "md", conteudoTexto: MOCK_RELATORIO_MD },
      { nome: "mapa-mental.json", tipo: "json", conteudoJson: MOCK_MINDMAP_JSON },
      { nome: "Aula 01 - Operacoes.md", tipo: "md", conteudoTexto: "# Aula 01 - Operações Reais\nTexto base" },
      { nome: "dados_experimento.json", tipo: "json" }
    ];

    const sep = separarArtefatosDaAula(arquivosMistos);
    assert.equal(sep.resumoMds.length, 1);
    assert.equal(sep.resumoMds[0].nome, "Aula 01 - Operacoes.md");
    assert.equal(sep.artifacts.mindmap.nome, "mapa-mental.json");
    assert.equal(sep.artifacts.flashcards.nome, "flashcards.md");
    assert.equal(sep.artifacts.quiz.nome, "quiz.md");
    assert.equal(sep.artifacts.relatorio.nome, "relatorio.md");

    // Nunca enviar mapa-mental.json, flashcards.md, quiz.md ou relatorio.md para o Cofre Admin (Camada 11)
    assert.equal(ehArquivoMaterialBrutoPermitido("json", { nome: "mapa-mental.json" }), false);
    assert.equal(ehArquivoMaterialBrutoPermitido("md", { nome: "flashcards.md" }), false);
    assert.equal(ehArquivoMaterialBrutoPermitido("md", { nome: "quiz.md" }), false);
    assert.equal(ehArquivoMaterialBrutoPermitido("md", { nome: "relatorio.md" }), false);
    // Outros JSONs e MDs continuam permitidos no Cofre Admin
    assert.equal(ehArquivoMaterialBrutoPermitido("json", { nome: "dados_experimento.json" }), true);
    assert.equal(ehArquivoMaterialBrutoPermitido("md", { nome: "Aula 01 - Operacoes.md" }), true);

    const inv = resolverInventarioArquivosAula({ id: "aula-x", arquivos: arquivosMistos }, "");
    assert.equal(inv.arquivos.some(a => a.nome === "mapa-mental.json"), false);
    assert.equal(inv.arquivos.some(a => a.nome === "flashcards.md"), false);
    assert.equal(inv.arquivos.some(a => a.nome === "dados_experimento.json"), true);
    assert.equal(inv.arquivos.some(a => a.nome === "Aula 01 - Operacoes.md"), true);

    // obterTituloAula não pode ser sequestrado por flashcards.md / quiz.md / relatorio.md
    const titulo = obterTituloAula({ nome: "Aula 01", arquivos: arquivosMistos });
    assert.equal(titulo, "Operações Reais");
  });

  it("deve normalizar db bruto movendo os 4 novos artefatos para lesson.artifacts e URLs sem poluir lesson.arquivos", () => {
    const rawDrive = {
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "⚙️ Operações",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "1° semestre/Operações/Aula 01",
                  filhos: [
                    { nome: "Aula 01 - Resumo.md", local: "1° semestre/Operações/Aula 01/Aula 01 - Resumo.md", conteudoTexto: "# Resumo Real" },
                    { nome: "mapa-mental.json", local: "1° semestre/Operações/Aula 01/mapa-mental.json", conteudoJson: MOCK_MINDMAP_JSON },
                    { nome: "flashcards.md", local: "1° semestre/Operações/Aula 01/flashcards.md", conteudoTexto: MOCK_FLASHCARDS_MD },
                    { nome: "quiz.md", local: "1° semestre/Operações/Aula 01/quiz.md", conteudoTexto: MOCK_QUIZ_MD },
                    { nome: "relatorio.md", local: "1° semestre/Operações/Aula 01/relatorio.md", conteudoTexto: MOCK_RELATORIO_MD }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const db = normalizarDb(rawDrive);
    const aula = db.semestres[0].disciplinas[0].aulas[0];
    assert.equal(aula.arquivos.length, 1);
    assert.equal(aula.arquivos[0].nome, "Aula 01 - Resumo.md");
    assert.ok(aula.artifacts.mindmap);
    assert.ok(aula.artifacts.flashcards);
    assert.ok(aula.artifacts.quiz);
    assert.ok(aula.artifacts.relatorio);
    assert.equal(aula.mindmapUrl, "1° semestre/Operações/Aula 01/mapa-mental.json");
    assert.equal(aula.flashcardsUrl, "1° semestre/Operações/Aula 01/flashcards.md");
    assert.equal(aula.quizUrl, "1° semestre/Operações/Aula 01/quiz.md");
    assert.equal(aula.relatorioUrl, "1° semestre/Operações/Aula 01/relatorio.md");
  });

  it("parseFlashcardsMarkdown deve extrair cards com resiliência a espaços, --- e escapes", () => {
    const cardsMock = parseFlashcardsMarkdown(MOCK_FLASHCARDS_MD);
    assert.equal(cardsMock.length, 4);
    assert.equal(cardsMock[0].id, "card-1");
    assert.equal(cardsMock[0].number, 1);
    assert.ok(cardsMock[0].question.includes("coração pulsante"));
    assert.equal(cardsMock[0].answer, "O Processo de Transformação (Input → Processo → Output).");
    assert.equal(cardsMock[3].number, 4);

    const mdComEscapes = `\\# Flashcards\n\n\\#\\# Card 10\n\n\\*\\*Q:\\*\\* Linha 1\nLinha 2 da pergunta\n\n\\*\\*A:\\*\\* Resposta completa\ncom quebra de linha\n\n---\n`;
    const cardsEsc = parseFlashcardsMarkdown(mdComEscapes);
    assert.equal(cardsEsc.length, 1);
    assert.equal(cardsEsc[0].number, 10);
    assert.ok(cardsEsc[0].question.includes("Linha 2 da pergunta"));
    assert.ok(cardsEsc[0].answer.includes("com quebra de linha"));

    const mdContentBlock = [
      "# Desenvolvimento Web Flashcards",
      "",
      "## Card 14",
      "",
      "**Q:** {'flashcardContentBlock': [{'type': 'image', 'reference': 'abc-123', 'alt': 'Diagrama TCP'}, {'type': 'text', 'content': \"Qual mecanismo 'handshake' está ilustrado?\"}]}",
      "",
      "**A:** {'flashcardContentBlock': [{'type': 'text', 'content': '• Etapa 1: SYN\\n• Etapa 2: ACK ($\\\\rightarrow$ Conexão)'}]}",
      ""
    ].join("\n");
    const cardsBlock = parseFlashcardsMarkdown(mdContentBlock);
    assert.equal(cardsBlock.length, 1);
    assert.equal(cardsBlock[0].number, 14);
    assert.ok(cardsBlock[0].question.includes("[Imagem: Diagrama TCP]"));
    assert.ok(cardsBlock[0].question.includes("Qual mecanismo 'handshake' está ilustrado?"));
    assert.equal(cardsBlock[0].question.includes("flashcardContentBlock"), false);
    assert.ok(cardsBlock[0].answer.includes("Etapa 1: SYN\n• Etapa 2: ACK"));
    assert.equal(extrairTextoFlashcardBlock("Texto puro normal"), "Texto puro normal");

    assert.deepEqual(parseFlashcardsMarkdown(""), []);
    assert.deepEqual(parseFlashcardsMarkdown(null), []);
  });

  it("parseQuizMarkdown deve extrair enunciado, alternativas correct true/false e **Hint:**", () => {
    const questions = parseQuizMarkdown(MOCK_QUIZ_MD);
    assert.equal(questions.length, 2);

    const q1 = questions[0];
    assert.equal(q1.id, "question-1");
    assert.equal(q1.number, 1);
    assert.ok(q1.prompt.includes("hospital decide implementar"));
    assert.equal(q1.options.length, 4);
    assert.equal(q1.options[0].correct, false);
    assert.equal(q1.options[1].correct, true);
    assert.equal(q1.options[1].letter, "B");
    assert.equal(q1.correctIndex, 1);
    assert.ok(q1.hint.includes("quanto o cliente pode observar"));

    const q2 = questions[1];
    assert.equal(q2.number, 2);
    assert.equal(q2.correctIndex, 1);
    assert.ok(q2.hint.includes("cobertor curto"));

    assert.deepEqual(parseQuizMarkdown(""), []);
    assert.deepEqual(parseQuizMarkdown(undefined), []);
  });

  it("normalizeMindmapTree deve estruturar níveis, ramos herdados, arestas e genealogia", () => {
    const norm = normalizeMindmapTree(MOCK_MINDMAP_JSON);
    assert.ok(norm.root !== null);
    assert.equal(norm.root.level, 0);
    assert.equal(norm.root.branchIndex, -1);
    assert.equal(norm.root.children.length, 4);
    assert.equal(norm.maxDepth, 3);
    assert.equal(norm.edges.length, norm.totalNodes - 1);

    // Ramo 0 (Modelo de Transformação) -> filho level 2 -> folha level 3 herdam branchIndex 0
    const ramo0 = norm.root.children[0];
    assert.equal(ramo0.level, 1);
    assert.equal(ramo0.branchIndex, 0);
    const subNo = ramo0.children[0];
    assert.equal(subNo.level, 2);
    assert.equal(subNo.branchIndex, 0);
    const folha = subNo.children[0];
    assert.equal(folha.level, 3);
    assert.equal(folha.branchIndex, 0);
    assert.deepEqual(folha.ancestorIds, [norm.root.id, ramo0.id, subNo.id]);

    // Ramo 3 (Estratégia de Produção) -> branchIndex 3
    assert.equal(norm.root.children[3].branchIndex, 3);

    // Deve aceitar JSON em string e tratar entrada inválida sem lançar erro
    const fromStr = normalizeMindmapTree(JSON.stringify({ name: "Raiz", children: [{ name: "Filho" }] }));
    assert.equal(fromStr.totalNodes, 2);
    assert.equal(normalizeMindmapTree("{json-invalido").root, null);
    assert.equal(normalizeMindmapTree(null).totalNodes, 0);
  });

  it("deve exibir avisos padronizados de falta apenas para Admin quando ausentes e renderizar camadas 1..11 em ordem estrita", async () => {
    const discMock = { id: "disc-op", nome: "Operações" };
    const aulaSemNovos = {
      id: "aula-sem-novos",
      nome: "Aula 01",
      linkNotebookLLM: "https://notebooklm.google.com/notebook/abc",
      arquivos: [
        { id: "md-1", nome: "Aula 01.md", tipo: "md", conteudoTexto: "# Aula 01\nResumo base" }
      ]
    };

    const artsAusentes = resolverArtefatosAula(aulaSemNovos);
    assert.equal(artsAusentes.mindmap.existe, false);
    assert.equal(artsAusentes.flashcards.existe, false);
    assert.equal(artsAusentes.quiz.existe, false);
    assert.equal(artsAusentes.relatorio.existe, false);

    // 1. Visitante sem novos artefatos -> Camadas 6..9 e avisos de falta permanecem ocultos; 10 renderiza e 11 oculto
    desautenticarAdmin();
    const htmlVisitante = montarConteudoInternoDaAula(discMock, aulaSemNovos);
    assert.equal(htmlVisitante.includes("6. Mapa Mental Neural"), false);
    assert.equal(htmlVisitante.includes("7. Flashcards 3D + SRS"), false);
    assert.equal(htmlVisitante.includes("8. Quiz Simulador Tático"), false);
    assert.equal(htmlVisitante.includes("9. Relatório Técnico"), false);
    assert.equal(htmlVisitante.includes("Falta Mapa Mental"), false);
    assert.equal(htmlVisitante.includes("Falta Flashcards"), false);
    assert.equal(htmlVisitante.includes("Falta Quiz"), false);
    assert.equal(htmlVisitante.includes("Falta Relatório Técnico"), false);
    assert.equal(htmlVisitante.includes("🤖 10. Inteligência Artificial da Aula (NotebookLM)"), true);
    assert.equal(htmlVisitante.includes("📂 11. Material Bruto Utilizado na Aula"), false);

    // 2. Admin sem novos artefatos -> Exibe avisos padronizados de falta (Camadas 6..9) + Camadas 10 e 11
    await autenticarAdmin("admin");
    const htmlAdminSemNovos = montarConteudoInternoDaAula(discMock, aulaSemNovos);
    assert.equal(htmlAdminSemNovos.includes("6. Mapa Mental Neural"), false);
    assert.equal(htmlAdminSemNovos.includes("⚠️ Falta Mapa Mental"), true);
    assert.equal(htmlAdminSemNovos.includes("⚠️ Falta Flashcards"), true);
    assert.equal(htmlAdminSemNovos.includes("⚠️ Falta Quiz"), true);
    assert.equal(htmlAdminSemNovos.includes("⚠️ Falta Relatório Técnico"), true);
    assert.equal(htmlAdminSemNovos.includes("🤖 10. Inteligência Artificial da Aula (NotebookLM)"), true);
    assert.equal(htmlAdminSemNovos.includes("📂 11. Material Bruto Utilizado na Aula"), true);

    // 3. Aula com os 4 artefatos reais -> Renderiza 1..11 em ordem vertical estrita, sem abrir texto do relatorio.md inline
    const aulaComNovos = {
      id: "aula-com-novos",
      nome: "Aula 02",
      linkNotebookLLM: "https://notebooklm.google.com/notebook/xyz",
      arquivos: [
        { id: "md-2", nome: "Aula 02.md", tipo: "md", conteudoTexto: "# Aula 02\nResumo real" }
      ],
      artifacts: {
        mindmap: { nome: "mapa-mental.json", tipo: "json", conteudoJson: MOCK_MINDMAP_JSON },
        flashcards: { nome: "flashcards.md", tipo: "md", conteudoTexto: MOCK_FLASHCARDS_MD },
        quiz: { nome: "quiz.md", tipo: "md", conteudoTexto: MOCK_QUIZ_MD },
        relatorio: { nome: "relatorio.md", tipo: "md", conteudoTexto: MOCK_RELATORIO_MD }
      }
    };

    const htmlComNovos = montarConteudoInternoDaAula(discMock, aulaComNovos);
    const idx1 = htmlComNovos.indexOf("📝 1. Resumo & Conteúdo da Aula");
    const idx6 = htmlComNovos.indexOf("🧠 6. Mapa Mental Neural");
    const idx7 = htmlComNovos.indexOf("🃏 7. Flashcards 3D + SRS");
    const idx8 = htmlComNovos.indexOf("🎯 8. Quiz Simulador Tático");
    const idx9 = htmlComNovos.indexOf("📄 9. Relatório Técnico da Aula");
    const idx10 = htmlComNovos.indexOf("🤖 10. Inteligência Artificial da Aula");
    const idx11 = htmlComNovos.indexOf("📂 11. Material Bruto Utilizado na Aula");

    assert.ok(idx1 >= 0 && idx6 > idx1 && idx7 > idx6 && idx8 > idx7 && idx9 > idx8 && idx10 > idx9 && idx11 > idx10);
    assert.ok(htmlComNovos.includes('data-action="open-relatorio-modal"'));
    assert.equal(htmlComNovos.includes("Este relatório estabelece um framework"), false);
  });

  it("deve persistir progresso SRS dos Flashcards e placar do Quiz isolados por lessonId no storage.js", () => {
    const aulaA = "aula-srs-a";
    const aulaB = "aula-srs-b";
    limparProgressoFlashcards(aulaA);
    limparProgressoFlashcards(aulaB);
    limparProgressoQuiz(aulaA);

    salvarAvaliacaoFlashcard(aulaA, "card-1", "hard");
    salvarAvaliacaoFlashcard(aulaA, "card-2", "easy");
    salvarAvaliacaoFlashcard(aulaB, "card-1", "medium");

    const progA = obterProgressoFlashcards(aulaA);
    const progB = obterProgressoFlashcards(aulaB);
    assert.equal(progA["card-1"].rating, "hard");
    assert.equal(progA["card-2"].rating, "easy");
    assert.equal(progB["card-1"].rating, "medium");

    salvarProgressoQuiz(aulaA, {
      answers: { "question-1": { selectedIndex: 1, isCorrect: true } },
      score: 1,
      total: 2
    });

    const quizA = obterProgressoQuiz(aulaA);
    assert.equal(quizA.score, 1);
    assert.equal(quizA.total, 2);
    assert.equal(quizA.answers["question-1"].isCorrect, true);

    limparProgressoFlashcards(aulaA);
    limparProgressoFlashcards(aulaB);
    limparProgressoQuiz(aulaA);
  });

  it("deve carregar sob demanda o RelatorioModal via dynamic import() e renderizar relatorio.md no modal", async () => {
    const relMod = await Modals.loadRelatorio();
    assert.ok(relMod !== null);
    assert.equal(typeof relMod.abrirModalRelatorio, "function");
    assert.equal(typeof relMod.fecharModalRelatorio, "function");

    const elements = new Map();
    const makeEl = (id = "") => {
      const classes = new Set(["hidden"]);
      return {
        id,
        innerHTML: "",
        attributes: {},
        classList: {
          add: (...cls) => cls.forEach(c => classes.add(c)),
          remove: (...cls) => cls.forEach(c => classes.delete(c)),
          contains: (c) => classes.has(c)
        },
        setAttribute: () => {},
        addEventListener: () => {}
      };
    };

    const prevDoc = global.document;
    global.document = {
      getElementById: (id) => elements.get(id) || null,
      createElement: () => makeEl(),
      body: {
        appendChild: (el) => {
          if (el.id) elements.set(el.id, el);
        }
      }
    };

    store.setState({
      db: {
        semestres: [
          {
            id: "sem-1",
            nome: "1° semestre",
            disciplinas: [
              {
                id: "disc-rel",
                nome: "Engenharia de Produção",
                icone: "⚙️",
                aulas: [
                  {
                    id: "aula-rel-1",
                    nome: "Aula 01",
                    arquivos: [{ nome: "Aula 01.md", tipo: "md", conteudoTexto: "# Processos Produtivos" }],
                    artifacts: {
                      relatorio: { nome: "relatorio.md", tipo: "md", conteudoTexto: MOCK_RELATORIO_MD }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    });

    try {
      await relMod.abrirModalRelatorio("disc-rel", "aula-rel-1");
      const modalEl = elements.get("modal-relatorio-tecnico");
      assert.ok(modalEl);
      assert.equal(modalEl.classList.contains("hidden"), false);
      assert.equal(modalEl.classList.contains("flex"), true);
      assert.ok(modalEl.innerHTML.includes("9. Relatório Técnico"));
      assert.ok(modalEl.innerHTML.includes("Executive Summary"));

      relMod.fecharModalRelatorio();
      assert.equal(modalEl.classList.contains("hidden"), true);
      assert.equal(modalEl.classList.contains("flex"), false);
    } finally {
      global.document = prevDoc;
    }
  });

  it("deve gerar cabeçalhos, controles e contadores corretos para Camadas 6, 7 e 8 sem campos de busca ou Demo", () => {
    const aula = { id: "aula-render-test", nome: "Aula 01" };
    const htmlMapa = renderMindmapSectionHtml(aula, { existe: true });
    assert.ok(htmlMapa.includes("🧠 6. Mapa Mental Neural"));
    assert.ok(htmlMapa.includes('data-gravity-btn="obsidian"'));
    assert.ok(htmlMapa.includes('data-gravity-btn="mindmap"'));
    assert.ok(htmlMapa.includes('data-gravity-btn="radial"'));
    assert.ok(htmlMapa.includes("data-mindmap-center"));
    assert.ok(htmlMapa.includes("data-mindmap-collapse-level"));
    assert.ok(htmlMapa.includes("data-mindmap-expand-level"));
    assert.ok(htmlMapa.includes('data-zoom-action="default"'));
    assert.equal(htmlMapa.includes("MODO DEMO"), false);
    assert.equal(htmlMapa.includes("Buscar neurônio"), false);
    assert.equal(htmlMapa.includes("Filtrar Flashcards"), false);

    const htmlCards = renderFlashcardsSectionHtml(aula, { existe: true, markdown: MOCK_FLASHCARDS_MD });
    assert.ok(htmlCards.includes("🃏 7. Flashcards 3D + SRS"));
    assert.ok(htmlCards.includes("Card 1 de 4"));
    assert.equal(htmlCards.includes("MODO DEMO"), false);
    assert.equal(htmlCards.includes("Filtrar flashcards"), false);

    const htmlQuiz = renderQuizSectionHtml(aula, { existe: true, markdown: MOCK_QUIZ_MD });
    assert.ok(htmlQuiz.includes("🎯 8. Quiz Simulador Tático"));
    assert.ok(htmlQuiz.includes("Acertos: 0 / 2"));
    assert.equal(htmlQuiz.includes("MODO DEMO"), false);
  });

  it("recolherUmNivelGlobal e expandirUmNivelGlobal devem recolher das folhas até a raiz e expandir inversamente até as folhas", () => {
    const tree = normalizeMindmapTree(MOCK_MINDMAP_JSON);
    const collapsedIds = new Set();

    // Estado inicial: todos os níveis visíveis (0..3)
    const estado0 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(estado0.maxVisibleDepth, 3);
    assert.equal(estado0.visibleIds.size, tree.totalNodes);
    assert.equal(estado0.hasCollapsedVisible, false);

    // Passo 1 de recolhimento: oculta as folhas (nível 3), mantendo níveis 0..2 visíveis
    assert.equal(recolherUmNivelGlobal(tree, collapsedIds), true);
    const estado1 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(estado1.maxVisibleDepth, 2);
    assert.equal(estado1.hasCollapsedVisible, true);

    // Passo 2: oculta sub-nós (nível 2), mantendo níveis 0..1 visíveis
    assert.equal(recolherUmNivelGlobal(tree, collapsedIds), true);
    const estado2 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(estado2.maxVisibleDepth, 1);

    // Passo 3: oculta os ramos principais (nível 1), sobrando apenas o nó raiz (nível 0)
    assert.equal(recolherUmNivelGlobal(tree, collapsedIds), true);
    const estado3 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(estado3.maxVisibleDepth, 0);
    assert.equal(estado3.visibleIds.size, 1);
    assert.ok(estado3.visibleIds.has(tree.root.id));

    // Recolhimento adicional na raiz não altera mais
    assert.equal(recolherUmNivelGlobal(tree, collapsedIds), false);

    // Caminho inverso — Passo 1 de expansão: libera nível 1 a partir da raiz
    assert.equal(expandirUmNivelGlobal(tree, collapsedIds), true);
    const exp1 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(exp1.maxVisibleDepth, 1);
    assert.equal(exp1.visibleIds.size, 1 + tree.root.children.length);

    // Passo 2 de expansão: libera nível 2
    assert.equal(expandirUmNivelGlobal(tree, collapsedIds), true);
    const exp2 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(exp2.maxVisibleDepth, 2);

    // Passo 3 de expansão: libera nível 3 (todas as folhas visíveis novamente)
    assert.equal(expandirUmNivelGlobal(tree, collapsedIds), true);
    const exp3 = calcularVisibilidadeArvore(tree, collapsedIds);
    assert.equal(exp3.maxVisibleDepth, 3);
    assert.equal(exp3.visibleIds.size, tree.totalNodes);
    assert.equal(exp3.hasCollapsedVisible, false);

    // Expansão adicional com árvore toda aberta não altera mais
    assert.equal(expandirUmNivelGlobal(tree, collapsedIds), false);
  });
});
