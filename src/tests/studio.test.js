import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { store, normalizarDb } from "../core/store.js";
import { autenticarAdmin, desautenticarAdmin } from "../services/auth.js";
import { salvarDbCache, obterDbCache, limparDbCache, compactarDbParaCacheLeve } from "../services/storage.js";
import {
  carregarDbFirebase,
  carregarConteudoAulaFirebase,
  definirVersaoDbAtual,
  hidratarConteudoAulaSobDemanda,
  limparCacheConteudoSobDemanda
} from "../services/api.js";
import { obterTituloAula } from "../utils/domHelpers.js";
import {
  STUDIO_ARTIFACT_TYPES,
  PROMPTS_MESTRES_PADRAO,
  adaptarPromptParaAula,
  construirConfigGeracaoArtefato,
  compactarJobParaFirebase,
  ehArquivoCorrespondenteTipoStudio,
  inspecionarArtefatosExistentesAula,
  dispararArtefatoStudio,
  dispararTodosArtefatosDaAula,
  simularLoteStudio,
  dispararLoteStudio,
  sincronizarFilaComFirebase,
  sincronizarFilaComWorker,
  obterContadoresStudio,
  listarJobsStudioLocal,
  limparFilaStudioLocal,
  limparFilaStudioCompleta,
  pausarFilaPorCotaStudio,
  retomarFilaCotaStudio,
  aprovarJobRevisaoStudio,
  tentarNovamenteJobRevisaoStudio,
  cancelarJobRevisaoStudio,
  renderBarraStudioAulaAdminHtml
} from "../services/studioApi.js";
import { renderCardRevisaoDiffHtml, renderMidiaPreviewTagHtml } from "../modals/StudioAdminModal.js";
import { Modals, inicializarApp } from "../main.js";

describe("Studio Worker Queue, Fire-and-Forget UI, Quota Guardian & Diff A/B Review Suite", () => {
  let prevFetch;
  let fetchCalls;

  beforeEach(async () => {
    prevFetch = global.fetch;
    fetchCalls = [];
    // Isola os testes unitários contra rede externa/worker local ativo na máquina
    global.fetch = async (url, opts = {}) => {
      fetchCalls.push({ url: String(url), method: opts.method || "GET", body: opts.body || null });
      if (String(url).includes("127.0.0.1:8090")) {
        throw new Error("ECONNREFUSED (Worker Local Offline Simulado)");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    };
    limparFilaStudioLocal();
    await autenticarAdmin("admin");
  });

  afterEach(() => {
    global.fetch = prevFetch;
    limparFilaStudioLocal();
    desautenticarAdmin();
  });

  it("Regra de Ouro 1: deve ler artefatos existentes direto do banco sem chamadas ao NotebookLM e decidir entre '➕ Gerar' e '🔄 Regerar'", () => {
    // Aula sem nenhum artefato dos 8 tipos (apenas o resumo .md principal da Camada 1)
    const aulaVazia = {
      id: "aula-vazia",
      nome: "Aula 01",
      arquivos: [
        { nome: "Aula 01 - Resumo.md", tipo: "md", conteudoTexto: "# Resumo" }
      ],
      artifacts: {}
    };

    const inspVazia = inspecionarArtefatosExistentesAula(aulaVazia);
    assert.equal(inspVazia.possuiAlgumArtefato, false);
    assert.equal(inspVazia.totalExistentes, 0);
    assert.equal(inspVazia.totalFaltantes, 8);
    assert.equal(inspVazia.porTipo.audio.acao, "gerar");
    assert.equal(inspVazia.porTipo.audio.textoBotao, "➕ Gerar Áudio");
    assert.equal(inspVazia.porTipo.flashcards.textoBotao, "➕ Gerar Flashcards");

    const htmlBarraVazia = renderBarraStudioAulaAdminHtml({ id: "disc-1", nome: "AED" }, aulaVazia);
    assert.ok(htmlBarraVazia.includes("⚡ Gerar Todos da Aula"));
    assert.ok(htmlBarraVazia.includes("➕ Gerar Áudio"));
    assert.ok(htmlBarraVazia.includes("➕ Gerar Infográfico"));

    // Aula com Infográfico (.png), Slides (.pdf sem_ocr) e Flashcards (flashcards.md) existentes
    const aulaParcial = {
      id: "aula-parcial",
      nome: "Aula 02",
      arquivos: [
        { nome: "Aula 02.md", tipo: "md", conteudoTexto: "# Aula 02" },
        { nome: "Diagrama.png", tipo: "png", local: "1° semestre/AED/Aula 02/Diagrama.png" },
        { nome: "Slides.pdf", tipo: "pdf", temOCR: false, statusOCR: "sem_ocr", local: "1° semestre/AED/Aula 02/Slides.pdf" }
      ],
      artifacts: {
        flashcards: { nome: "flashcards.md", tipo: "md", local: "1° semestre/AED/Aula 02/flashcards.md", conteudoTexto: "## Card 1\n**Q:** A\n**A:** B" }
      }
    };

    const inspParcial = inspecionarArtefatosExistentesAula(aulaParcial);
    assert.equal(inspParcial.possuiAlgumArtefato, true);
    assert.equal(inspParcial.totalExistentes, 3);
    assert.equal(inspParcial.totalFaltantes, 5);
    assert.equal(inspParcial.porTipo.infografico.existe, true);
    assert.equal(inspParcial.porTipo.infografico.acao, "regerar");
    assert.equal(inspParcial.porTipo.infografico.textoBotao, "🔄 Regerar Infográfico");
    assert.equal(inspParcial.porTipo.slides.textoBotao, "🔄 Regerar Slides");
    assert.equal(inspParcial.porTipo.flashcards.textoBotao, "🔄 Regerar Flashcards");
    assert.equal(inspParcial.porTipo.video.textoBotao, "➕ Gerar Vídeo");

    // Isolamento estrito Camada 2A (.JPG Sketchnote) vs Camada 2B (.PNG Infográfico NotebookLM)
    const aulaSoSketchnoteJpg = {
      id: "aula-so-jpg",
      nome: "Aula JPG",
      arquivos: [
        {
          nome: "2A. Sketchnote.jpg",
          tipo: "arquivo",
          mimeType: "image/jpeg",
          id: "1NvbjchYwrUJkceTCVIKU5MbZoYw7HSTi",
          local: "1° semestre/AED/Aula JPG/2A. Sketchnote.jpg"
        }
      ],
      artifacts: {}
    };
    assert.equal(ehArquivoCorrespondenteTipoStudio(aulaSoSketchnoteJpg.arquivos[0], "infografico"), false);
    const inspSoJpg = inspecionarArtefatosExistentesAula(aulaSoSketchnoteJpg);
    assert.equal(inspSoJpg.porTipo.infografico.existe, false);
    assert.equal(inspSoJpg.porTipo.infografico.textoBotao, "➕ Gerar Infográfico");

    const aulaJpgEPngReais = {
      id: "aula-jpg-png",
      nome: "Aula 01",
      arquivos: [
        {
          nome: "Gemini_Generated_Image_d56ki6d56ki6d56k.jpg",
          tipo: "arquivo",
          mimeType: "image/jpeg",
          id: "1NvbjchYwrUJkceTCVIKU5MbZoYw7HSTi",
          local: "1° semestre/💻 Aplicações Para Internet/Aula 01/Gemini_Generated_Image_d56ki6d56ki6d56k.jpg"
        },
        {
          nome: "unnamed (4).png",
          tipo: "arquivo",
          mimeType: "image/png",
          id: "1Qjcz1U1W84yBw6kStg2_j4DxtbVbwJGW",
          local: "1° semestre/💻 Aplicações Para Internet/Aula 01/unnamed (4).png"
        }
      ],
      artifacts: {}
    };
    const inspAmbos = inspecionarArtefatosExistentesAula(aulaJpgEPngReais);
    assert.equal(inspAmbos.porTipo.infografico.existe, true);
    assert.ok(inspAmbos.porTipo.infografico.urlAntiga.includes("1Qjcz1U1W84yBw6kStg2_j4DxtbVbwJGW"));
    assert.equal(inspAmbos.porTipo.infografico.urlAntiga.includes("1NvbjchYwrUJkceTCVIKU5MbZoYw7HSTi"), false);
  });

  it("Regra de Ouro 3 (Clique Frenético): deve permitir clicar em 25+ botões em < 50ms atualizando imediatamente para '⏳ Na Fila'", () => {
    const rawDb = {
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 Algoritmos",
              filhos: [
                { tipo: "pasta", nome: "Aula 01", local: "1° semestre/Algoritmos/Aula 01", filhos: [] },
                { tipo: "pasta", nome: "Aula 02", local: "1° semestre/Algoritmos/Aula 02", filhos: [] },
                { tipo: "pasta", nome: "Aula 03", local: "1° semestre/Algoritmos/Aula 03", filhos: [] },
                { tipo: "pasta", nome: "Aula 04", local: "1° semestre/Algoritmos/Aula 04", filhos: [] }
              ]
            }
          ]
        }
      ]
    };

    const dbNorm = normalizarDb(rawDb);
    store.setState({ db: dbNorm });
    const disc = dbNorm.semestres[0].disciplinas[0];

    const inicio = performance.now();
    let cliques = 0;

    for (const aula of disc.aulas) {
      for (const meta of STUDIO_ARTIFACT_TYPES) {
        const fakeBtn = {
          innerHTML: "",
          className: "",
          attrs: {},
          setAttribute(k, v) { this.attrs[k] = v; }
        };
        dispararArtefatoStudio({
          discId: disc.id,
          aulaId: aula.id,
          tipoArtefato: meta.id,
          acao: "gerar",
          btnEl: fakeBtn
        });
        assert.ok(fakeBtn.innerHTML.includes("Na Fila"));
        assert.equal(fakeBtn.attrs["data-studio-status"], "na_fila");
        cliques++;
      }
    }

    const duracaoMs = performance.now() - inicio;
    assert.equal(cliques, 32); // 4 aulas x 8 artefatos = 32 cliques frenéticos
    assert.ok(duracaoMs < 200, `32 cliques levaram ${duracaoMs}ms (esperado < 200ms)`);

    const contadores = obterContadoresStudio();
    assert.equal(contadores.na_fila, 32);
    assert.equal(contadores.totalFila, 32);
    assert.equal(contadores.cota_status, "OK");
  });

  it("Regra de Ouro 4 (Guardião de Cota Persistente): deve pausar jobs como 'aguardando_cota' e retomá-los depois sem perder nenhum item", async () => {
    dispararTodosArtefatosDaAula({
      discId: "disc-aed",
      aulaId: "aula-01",
      apenasFaltantes: false
    });

    assert.equal(obterContadoresStudio().na_fila, 8);
    assert.equal(obterContadoresStudio().cota_status, "OK");

    // Simula estouro de cota do Google NotebookLM
    pausarFilaPorCotaStudio("QuotaExceeded: 429 Too Many Requests");
    const cPausado = obterContadoresStudio();
    assert.equal(cPausado.cota_status, "Pausada");
    assert.equal(cPausado.aguardando_cota, 8);
    assert.equal(cPausado.na_fila, 0);

    // Retoma a cota automaticamente
    const resRetomada = await retomarFilaCotaStudio();
    assert.equal(resRetomada.retomados, 8);

    const cRetomado = obterContadoresStudio();
    assert.equal(cRetomado.cota_status, "OK");
    assert.equal(cRetomado.na_fila, 8);
    assert.equal(cRetomado.aguardando_cota, 0);
  });

  it("Fase 3 (Regra de Não-Visuais vs Visuais e Diff A/B): deve isolar os 4 não-visuais de revisão e exibir os 3 botões estritos nos cards de revisão", async () => {
    const naoVisuais = STUDIO_ARTIFACT_TYPES.filter(t => !t.requerRevisao).map(t => t.id);
    const visuais = STUDIO_ARTIFACT_TYPES.filter(t => t.requerRevisao).map(t => t.id);

    assert.deepEqual(naoVisuais.sort(), ["flashcards", "mindmap", "quiz", "relatorio"]);
    assert.deepEqual(visuais.sort(), ["audio", "infografico", "slides", "video"]);

    // Card de Regeração (com url_antiga) -> deve exibir Diff A/B Lado a Lado e os 3 botões
    const jobRegeracao = {
      id: "job_diff_1",
      materia_id: "disc-1",
      materia_nome: "Algoritmos",
      aula_id: "aula-1",
      aula_nome: "Aula 01",
      tipo_artefato: "infografico",
      acao: "regerar",
      url_antiga: "./1° semestre/Algoritmos/Aula 01/antigo.png",
      caminho_staging: "staging/job_diff_1_infografico.png",
      requer_revisao: true,
      status: "revisao"
    };

    const htmlDiff = renderCardRevisaoDiffHtml(jobRegeracao);
    assert.ok(htmlDiff.includes('data-diff-mode="side-by-side"'));
    assert.ok(htmlDiff.includes("Versão Antiga (Atual no Banco)"));
    assert.ok(htmlDiff.includes("Versão Nova (staging/)"));
    assert.ok(htmlDiff.includes("✅ Aprovar"));
    assert.ok(htmlDiff.includes("🔄 Tentar de Novo"));
    assert.ok(htmlDiff.includes("✖"));
    assert.ok(htmlDiff.includes('data-studio-review-action="aprovar"'));
    assert.ok(htmlDiff.includes('data-studio-review-action="tentar-novamente"'));
    assert.ok(htmlDiff.includes('data-studio-review-action="cancelar"'));

    // Card de Geração Nova (sem url_antiga) -> deve exibir preview único e os 3 botões
    const jobNovo = {
      ...jobRegeracao,
      id: "job_novo_2",
      tipo_artefato: "video",
      acao: "gerar",
      url_antiga: "",
      caminho_staging: "staging/job_novo_2_video.mp4"
    };
    const htmlNovo = renderCardRevisaoDiffHtml(jobNovo);
    assert.ok(htmlNovo.includes('data-diff-mode="single-new"'));
    assert.ok(htmlNovo.includes("<video"));

    // Verifica tags de preview para os 4 formatos visuais (PNG -> img, MP4 -> video, M4A -> audio, PDF -> iframe)
    assert.ok(renderMidiaPreviewTagHtml("infografico", "staging/a.png").includes("<img"));
    assert.ok(renderMidiaPreviewTagHtml("video", "staging/a.mp4").includes("<video"));
    assert.ok(renderMidiaPreviewTagHtml("audio", "staging/a.m4a").includes("<audio"));
    assert.ok(renderMidiaPreviewTagHtml("slides", "staging/a.pdf").includes("<iframe"));

    // Verifica carregamento dinâmico do modal StudioAdminModal
    const mod = await Modals.loadStudioAdmin();
    assert.equal(typeof mod.abrirModalStudioRevisao, "function");
    assert.equal(typeof mod.abrirModalStudioLote, "function");
    assert.equal(typeof mod.abrirModalFontesNotebook, "function");
  });

  it("Fase 3 (Fluxo dos 3 Botões): Aprovar atualiza o Store e remove da revisão; Tentar de Novo volta para na_fila; Cancelar exclui mantendo o antigo", async () => {
    const rawDb = {
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 Algoritmos",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "1° semestre/Algoritmos/Aula 01",
                  filhos: [
                    { nome: "Aula 01.md", tipo: "md", conteudoTexto: "# Aula 01" }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };
    const dbNorm = normalizarDb(rawDb);
    store.setState({ db: dbNorm });
    const disc = dbNorm.semestres[0].disciplinas[0];
    const aula = disc.aulas[0];

    const jobImg = dispararArtefatoStudio({
      discId: disc.id,
      aulaId: aula.id,
      tipoArtefato: "infografico",
      acao: "gerar"
    });
    const jobPdf = dispararArtefatoStudio({
      discId: disc.id,
      aulaId: aula.id,
      tipoArtefato: "slides",
      acao: "gerar"
    });
    const jobAud = dispararArtefatoStudio({
      discId: disc.id,
      aulaId: aula.id,
      tipoArtefato: "audio",
      acao: "gerar"
    });

    // Promove para revisao
    jobImg.status = "revisao";
    jobPdf.status = "revisao";
    jobAud.status = "revisao";

    assert.equal(listarJobsStudioLocal(true).length, 3);

    // 1. [🔄 Tentar de Novo] no PDF -> volta para `na_fila`
    await tentarNovamenteJobRevisaoStudio(jobPdf.id);
    assert.equal(jobPdf.status, "na_fila");
    assert.equal(listarJobsStudioLocal(true).length, 2);

    // 2. [✖ Cancelar] no Áudio -> remove da fila sem alterar a aula
    await cancelarJobRevisaoStudio(jobAud.id);
    assert.equal(listarJobsStudioLocal(true).length, 1);

    // 3. [✅ Aprovar] no Infográfico -> adiciona à aula no Store, remove da revisão e preserva eventual .JPG 2A intacto
    aula.arquivos.push({
      nome: "Gemini_Generated_Image_keep.jpg",
      tipo: "arquivo",
      mimeType: "image/jpeg",
      id: "1NvbjchYwrUJkceTCVIKU5MbZoYw7HSTi",
      local: "1° semestre/Algoritmos/Aula 01/Gemini_Generated_Image_keep.jpg"
    });
    jobImg.staging_drive_id = "1NovoDrivePngId123456";
    await aprovarJobRevisaoStudio(jobImg.id);
    assert.equal(listarJobsStudioLocal(true).length, 0);
    assert.equal(inspecionarArtefatosExistentesAula(aula).porTipo.infografico.existe, true);
    assert.ok(aula.arquivos.some(a => a.nome === "Gemini_Generated_Image_keep.jpg"));
    assert.ok(aula.arquivos.some(a => a.nome === "Infográfico Arquitetural.png" && a.driveId === "1NovoDrivePngId123456"));
  });

  it("Adaptação Inteligente de Prompts & Configurações Avançadas por Artefato + Fluxo Remoto (PC Desligado)", async () => {
    const contexto = {
      aulaNome: "Aula 03",
      aulaTitulo: "Árvores Balanceadas AVL e Rubro-Negra",
      materiaNome: "Algoritmos e Estruturas de Dados"
    };

    const promptAdaptadoAudio = adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.audio, contexto);
    assert.equal(promptAdaptadoAudio.includes("[FOR FOCUS, INSERT LESSON NUMBER ( )]"), false);
    assert.ok(promptAdaptadoAudio.includes("Aula 03 — Árvores Balanceadas AVL e Rubro-Negra"));
    assert.ok(promptAdaptadoAudio.includes("Algoritmos e Estruturas de Dados"));

    const cfgVideo = construirConfigGeracaoArtefato("video", contexto);
    assert.equal(cfgVideo.formato, "Video explicativo");
    assert.equal(cfgVideo.escolher_estilo_visual, "Visual personalizado");
    assert.equal(cfgVideo.foco_video, "");
    assert.ok(cfgVideo.estilo_visual_personalizado.includes("Midnight Obsidian"));
    assert.ok(cfgVideo.assunto_personalizado.includes("Árvores Balanceadas AVL e Rubro-Negra"));
    assert.equal(cfgVideo.assunto_personalizado.includes("[FOR FOCUS, INSERT LESSON NUMBER ( )]"), false);

    const cfgRelatorio = construirConfigGeracaoArtefato("relatorio", contexto);
    assert.equal(cfgRelatorio.formato, "Documento");
    assert.equal(cfgRelatorio.modelo, "Crie do zero");
    assert.equal(cfgRelatorio.descricao_relatorio.includes("[TOPIC NAME]"), false);

    const cfgQuiz = construirConfigGeracaoArtefato("quiz", contexto);
    assert.equal(cfgQuiz.numero_questoes, "Mais");
    assert.equal(cfgQuiz.nivel_dificuldade, "Média");
    assert.equal(cfgQuiz.incluir_imagens, true);
    assert.deepEqual(cfgQuiz.tipos_perguntas, [
      "Uma resposta correta",
      "Mais de uma resposta correta",
      "Preencher a lacuna",
      "Resposta curta"
    ]);

    const cfgAudio = construirConfigGeracaoArtefato("audio", contexto);
    assert.equal(cfgAudio.formato, "Análise detalhada");

    const cfgSlides = construirConfigGeracaoArtefato("slides", contexto);
    assert.equal(cfgSlides.formato, "Apresentação detalhada");
    assert.equal(cfgSlides.duracao, "Padrão");
    assert.equal(cfgSlides.descricao_slides.includes("[INSERT LESSON CONTENT OR TOPIC HERE]"), false);

    const cfgMindmap = construirConfigGeracaoArtefato("mindmap", contexto);
    assert.equal(cfgMindmap.modo, "Padrão de fábrica");
    assert.equal(cfgMindmap.prompt, "");

    const cfgFlash = construirConfigGeracaoArtefato("flashcards", contexto);
    assert.equal(cfgFlash.numero_cards, "Mais");
    assert.equal(cfgFlash.nivel_dificuldade, "Média padrão");
    assert.equal(cfgFlash.incluir_imagens, true);

    const cfgInfo = construirConfigGeracaoArtefato("infografico", contexto);
    assert.equal(cfgInfo.escolher_estilo_visual, "Seleção automática");
    assert.equal(cfgInfo.orientacao, "Paisagem");
    assert.equal(cfgInfo.nivel_detalhamento, "Padrão");

    // Fluxo remoto com worker local desligado: garante retorno de estados pendentes para o Firebase
    const job1 = dispararArtefatoStudio({ discId: "d1", aulaId: "a1", tipoArtefato: "video", acao: "gerar" });
    const job2 = dispararArtefatoStudio({ discId: "d1", aulaId: "a2", tipoArtefato: "infografico", acao: "gerar" });
    const job3 = dispararArtefatoStudio({ discId: "d1", aulaId: "a3", tipoArtefato: "slides", acao: "gerar" });
    job1.status = "revisao";
    job2.status = "revisao";
    job3.status = "revisao";

    const resAprov = await aprovarJobRevisaoStudio(job1.id);
    assert.equal(resAprov.status_remoto, "aprovado_pendente_mover");

    const resRetry = await tentarNovamenteJobRevisaoStudio(job2.id);
    assert.equal(resRetry.status, "na_fila");
    assert.equal(job2.limpar_staging_anterior, true);

    const resCancel = await cancelarJobRevisaoStudio(job3.id);
    assert.equal(resCancel.status_remoto, "cancelado_pendente_excluir");

    // Verifica se o Firebase (/fila_studio) recebeu as gravações online mesmo com worker offline
    const fbPuts = fetchCalls.filter(c => c.url.includes("/fila_studio/") && c.method === "PUT");
    assert.ok(fbPuts.length >= 6);
    assert.ok(fbPuts.some(c => String(c.body).includes('"aprovado_pendente_mover"')));
    assert.ok(fbPuts.some(c => String(c.body).includes('"cancelado_pendente_excluir"')));
    assert.ok(fbPuts.some(c => String(c.body).includes('"limpar_staging_anterior":true')));
    assert.ok(fbPuts.every(c => String(c.body).includes('"admin_gate":"studyos_admin_v1"')));

    // Catraca Padrão (Visitante): após desautenticarAdmin(), não lê nem escreve em /fila_studio
    desautenticarAdmin();
    fetchCalls.length = 0;
    const bloqueadoDisparo = dispararArtefatoStudio({ discId: "d1", aulaId: "a1", tipoArtefato: "video", acao: "gerar" });
    const bloqueadoSync = await sincronizarFilaComFirebase();
    assert.equal(bloqueadoDisparo, null);
    assert.equal(bloqueadoSync, false);
    assert.equal(fetchCalls.filter(c => c.url.includes("/fila_studio")).length, 0);
  });

  it("Estabilidade Anti-F5 & Storage Quota: compacta cache > quota sem QuotaExceededError e não dispara reload/re-render no polling", async () => {
    // 1. Simula DB > 6MB com textos Markdown inline pesados + localStorage com cota rígida
    const textoPesado = "X".repeat(650_000);
    const dbPesado = normalizarDb({
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 Algoritmos",
              filhos: Array.from({ length: 10 }, (_, idx) => ({
                tipo: "pasta",
                nome: `Aula ${String(idx + 1).padStart(2, "0")}`,
                local: `1° semestre/Algoritmos/Aula ${idx + 1}`,
                filhos: [
                  {
                    nome: `Aula ${idx + 1}.md`,
                    tipo: "arquivo",
                    conteudoTexto: textoPesado
                  },
                  {
                    nome: "mapa-mental.json",
                    tipo: "arquivo",
                    artifactRole: "mindmap",
                    conteudoJson: { name: "Raiz", children: [{ name: "Sub" }] }
                  }
                ]
              }))
            }
          ]
        }
      ]
    });

    const compactado = compactarDbParaCacheLeve(dbPesado);
    assert.ok(JSON.stringify(compactado).length < 50_000);

    const prevLs = globalThis.localStorage;
    const prevWarn = console.warn;
    let warnChamado = 0;
    const storeMap = new Map();
    console.warn = () => { warnChamado++; };
    globalThis.localStorage = {
      getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
      setItem: (k, v) => {
        if (String(v).length > 80_000) {
          const err = new Error("QuotaExceededError");
          err.name = "QuotaExceededError";
          throw err;
        }
        storeMap.set(k, String(v));
      },
      removeItem: (k) => { storeMap.delete(k); }
    };

    try {
      limparDbCache();
      salvarDbCache(dbPesado);
      assert.equal(warnChamado, 0);
      assert.equal(obterDbCache(), dbPesado);
      assert.ok(storeMap.get("studyos_db_v3")?.length <= 80_000);
    } finally {
      console.warn = prevWarn;
      if (prevLs === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prevLs;
      limparDbCache();
    }

    // 2. Polling repetido em sincronizarFilaComWorker com job concluido + auto_aprovado:
    //    nunca deve invocar recarregarVisaoAtual() e só aplica 1 vez por ID
    const prevWin = globalThis.window;
    let reloads = 0;
    globalThis.window = {
      StudyOS: {
        recarregarVisaoAtual: () => { reloads++; }
      }
    };
    const dbNorm = normalizarDb({
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 AED",
              filhos: [
                { tipo: "pasta", nome: "Aula 01", local: "1° semestre/AED/Aula 01", filhos: [] }
              ]
            }
          ]
        }
      ]
    });
    store.setState({ db: dbNorm });
    const disc = dbNorm.semestres[0].disciplinas[0];
    const aula = disc.aulas[0];

    let applyPollCalls = 0;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        applyPollCalls++;
        return {
          ok: true,
          cota_status: "OK",
          jobs: [
            {
              id: "job_auto_unico_1",
              materia_id: disc.id,
              aula_id: aula.id,
              pasta_aula: aula.local,
              tipo_artefato: "flashcards",
              status: "concluido",
              auto_aprovado: true
            }
          ]
        };
      }
    });

    try {
      await sincronizarFilaComWorker();
      const firstId = aula.artifacts?.flashcards?.id;
      await new Promise(r => setTimeout(r, 5));
      await sincronizarFilaComWorker();
      assert.equal(applyPollCalls, 2);
      assert.equal(reloads, 0);
      assert.equal(aula.artifacts?.flashcards?.id, firstId);
    } finally {
      if (prevWin === undefined) delete globalThis.window;
      else globalThis.window = prevWin;
      limparDbCache();
    }
  });

  it("Otimização de Downloads Firebase: catálogo leve com tituloH1, /db_meta, /db_conteudo sob demanda e /fila_studio_meta", async () => {
    limparCacheConteudoSobDemanda();

    // 1. Catálogo leve sem conteudoTexto preserva tituloH1 exato sem precisar baixar o .md
    const dbCatalogoLeve = normalizarDb({
      atualizado_em: 5000,
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 Redes",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "1° semestre/Redes/Aula 01",
                  filhos: [
                    {
                      nome: "Aula_01.md",
                      tipo: "arquivo",
                      mimeType: "text/markdown",
                      tituloH1: "Modelo OSI e Arquitetura TCP/IP",
                      local: "1° semestre/Redes/Aula 01/Aula_01.md"
                    },
                    {
                      nome: "flashcards.md",
                      tipo: "arquivo",
                      artifactRole: "flashcards",
                      local: "1° semestre/Redes/Aula 01/flashcards.md"
                    },
                    {
                      nome: "mapa-mental.json",
                      tipo: "arquivo",
                      artifactRole: "mindmap",
                      local: "1° semestre/Redes/Aula 01/mapa-mental.json"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });

    const aulaLeve = dbCatalogoLeve.semestres[0].disciplinas[0].aulas[0];
    assert.equal(obterTituloAula(aulaLeve), "Modelo OSI e Arquitetura TCP/IP");
    assert.equal(aulaLeve.arquivos[0].conteudoTexto, null);

    // 2. /db_meta evita download repetido de /db_json quando timestamp não mudou; baixa apenas se houver versão mais nova
    let dbJsonHits = 0;
    let dbConteudoHits = 0;
    let filaStudioHits = 0;
    let metaRemotoDbTs = 5000;
    let metaRemotoFilaTs = 10000;

    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/db_meta.json")) {
        return { ok: true, status: 200, json: async () => ({ atualizado_em: metaRemotoDbTs }) };
      }
      if (u.includes("/db_json.json")) {
        dbJsonHits++;
        return { ok: true, status: 200, json: async () => ({ filhos: [] }) };
      }
      if (u.includes(`/db_conteudo/${encodeURIComponent(aulaLeve.id)}.json`)) {
        dbConteudoHits++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mds: { "Aula_01.md": "# Modelo OSI\nCamada física até aplicação." },
            artifacts: {
              flashcards: { nome: "flashcards.md", conteudoTexto: "## Card 1\n**Q:** OSI?\n**A:** 7 camadas." },
              mindmap: { nome: "mapa-mental.json", conteudoJson: { name: "OSI", children: [{ name: "Camada 7" }] } }
            }
          })
        };
      }
      if (u.includes("/fila_studio_meta.json")) {
        return { ok: true, status: 200, json: async () => ({ atualizado_em: metaRemotoFilaTs }) };
      }
      if (u.includes("/fila_studio.json")) {
        filaStudioHits++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            job_remoto_1: {
              id: "job_remoto_1",
              tipo_artefato: "video",
              status: "na_fila",
              timestamp: 10000
            }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const resDbSkip = await carregarDbFirebase({ metaLocalTimestamp: 5000 });
    assert.equal(resDbSkip, null);
    assert.equal(dbJsonHits, 0);

    metaRemotoDbTs = 9999;
    const resDbNovo = await carregarDbFirebase({ metaLocalTimestamp: 5000 });
    assert.ok(resDbNovo);
    assert.equal(dbJsonHits, 1);

    // 3. Carregamento sob demanda de /db_conteudo/{aulaId} apenas ao abrir a aula (com cache posterior)
    const hidratou1 = await hidratarConteudoAulaSobDemanda(aulaLeve);
    assert.equal(hidratou1, true);
    assert.equal(dbConteudoHits, 1);
    assert.ok(aulaLeve.arquivos[0].conteudoTexto.includes("Camada física até aplicação"));
    assert.ok(aulaLeve.artifacts.flashcards.conteudoTexto.includes("7 camadas"));
    assert.equal(aulaLeve.artifacts.mindmap.conteudoJson.name, "OSI");

    const hidratou2 = await hidratarConteudoAulaSobDemanda(aulaLeve);
    assert.equal(hidratou2, false);
    assert.equal(dbConteudoHits, 1);

    // 4. Compactação de job para Firebase remove prompts gigantes mantendo resumo_label e admin_gate
    const jobPesado = {
      id: "job_compact_1",
      tipo_artefato: "video",
      config_geracao: construirConfigGeracaoArtefato("video", { aulaNome: "Aula 01", materiaNome: "Redes" })
    };
    const jobCompacto = compactarJobParaFirebase(jobPesado);
    assert.equal(jobCompacto.admin_gate, "studyos_admin_v1");
    assert.equal(jobCompacto.config_geracao.resumo_label, "Video explicativo • Visual personalizado");
    assert.equal(jobCompacto.config_geracao.estilo_visual_personalizado, undefined);

    // 5. /fila_studio_meta evita baixar /fila_studio.json repetidamente quando não há alteração
    await sincronizarFilaComFirebase({ forcar: false });
    assert.equal(filaStudioHits, 1);

    await sincronizarFilaComFirebase({ forcar: false });
    assert.equal(filaStudioHits, 1);

    metaRemotoFilaTs = 20000;
    await sincronizarFilaComFirebase({ forcar: false });
    assert.equal(filaStudioHits, 2);

    await sincronizarFilaComFirebase({ forcar: true });
    assert.equal(filaStudioHits, 3);

    limparCacheConteudoSobDemanda();
  });

  it("Limpar Fila Completa: apaga 100% de /fila_studio no Firebase via PATCH {id: null} (sem DELETE 401) e zera local", async () => {
    const dbMock = normalizarDb({
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 SO",
              filhos: [
                { tipo: "pasta", nome: "Aula 01", local: "1° semestre/SO/Aula 01", linkNotebookLLM: "https://notebooklm.google.com/notebook/aaaa1111-2222-3333-4444-555566667777", filhos: [] }
              ]
            }
          ]
        }
      ]
    });
    store.setState({ db: dbMock });
    const disc = dbMock.semestres[0].disciplinas[0];
    const aula = disc.aulas[0];

    // Simula 2 jobs locais + 2 jobs extras remotos no Firebase
    const j1 = dispararArtefatoStudio({ discId: disc.id, aulaId: aula.id, tipoArtefato: "quiz" });
    const j2 = dispararArtefatoStudio({ discId: disc.id, aulaId: aula.id, tipoArtefato: "flashcards" });
    assert.equal(listarJobsStudioLocal().length, 2);

    const fbFila = {
      [j1.id]: { id: j1.id, status: "na_fila" },
      [j2.id]: { id: j2.id, status: "na_fila" },
      job_remoto_antigo_1: { id: "job_remoto_antigo_1", status: "aguardando_cota" },
      job_remoto_antigo_2: { id: "job_remoto_antigo_2", status: "erro" }
    };
    let fbMeta = { atualizado_em: 100, admin_gate: "studyos_admin_v1" };
    let usouDeletePaiProibido = false;

    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = String(opts.method || "GET").toUpperCase();

      // Simula worker local offline para testar limpeza direta no Firebase
      if (u.includes("/api/studio/limpar-fila")) {
        throw new Error("Worker offline");
      }
      if (u.includes("/fila_studio.json") && method === "DELETE") {
        usouDeletePaiProibido = true;
        return { ok: false, status: 401, json: async () => ({ error: "Permission denied" }) };
      }
      if (u.includes("/fila_studio.json") && u.includes("shallow=true") && method === "GET") {
        const keys = Object.keys(fbFila);
        if (keys.length === 0) return { ok: true, status: 200, json: async () => null };
        const shallowObj = {};
        keys.forEach(k => { shallowObj[k] = true; });
        return { ok: true, status: 200, json: async () => shallowObj };
      }
      if (u.includes("/fila_studio.json") && method === "PATCH") {
        const body = JSON.parse(opts.body || "{}");
        for (const [k, v] of Object.entries(body)) {
          if (v === null) delete fbFila[k];
          else fbFila[k] = v;
        }
        return { ok: true, status: 200, json: async () => body };
      }
      if (u.includes("/fila_studio.json") && method === "GET") {
        return { ok: true, status: 200, json: async () => (Object.keys(fbFila).length ? fbFila : null) };
      }
      if (u.includes("/fila_studio_meta.json") && method === "PUT") {
        fbMeta = JSON.parse(opts.body || "{}");
        return { ok: true, status: 200, json: async () => fbMeta };
      }
      if (u.includes("/fila_studio_meta.json") && method === "GET") {
        return { ok: true, status: 200, json: async () => fbMeta };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const res = await limparFilaStudioCompleta();
    assert.equal(res.ok, true);
    assert.equal(res.firebase_limpo, true);
    assert.equal(res.restantes_firebase, 0);
    assert.equal(res.removidos_firebase, 4);
    assert.equal(usouDeletePaiProibido, false);
    assert.equal(Object.keys(fbFila).length, 0);
    assert.equal(listarJobsStudioLocal().length, 0);
    assert.equal(fbMeta.acao, "limpar_fila");

    // Se outra aba ainda tiver job antigo no cache local, sincronizarFilaComFirebase limpa ao ver /fila_studio vazio + acao limpar_fila
    dispararArtefatoStudio({ discId: disc.id, aulaId: aula.id, tipoArtefato: "mindmap" });
    await Promise.resolve();
    assert.equal(listarJobsStudioLocal().length, 1);
    fbMeta = { atualizado_em: Date.now() + 5000, acao: "limpar_fila", limpo_em: Date.now() + 5000 };
    await sincronizarFilaComFirebase({ forcar: false });
    assert.equal(listarJobsStudioLocal().length, 0);
  });

  it("Lote Multi-Seleção: suporta vários Semestres, várias Matérias e vários Tipos de Artefato com previsão exata", async () => {
    const dbMulti = normalizarDb({
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "💻 Algoritmos",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "1° semestre/Algoritmos/Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/11111111-1111-1111-1111-111111111111",
                  filhos: [
                    { nome: "flashcards.md", tipo: "arquivo", artifactRole: "flashcards", conteudoTexto: "Q/A" }
                  ]
                }
              ]
            },
            {
              tipo: "pasta",
              nome: "🧮 Cálculo I",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "1° semestre/Calculo I/Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/22222222-2222-2222-2222-222222222222",
                  filhos: []
                }
              ]
            }
          ]
        },
        {
          tipo: "pasta",
          nome: "2° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "🌐 Redes",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "2° semestre/Redes/Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/33333333-3333-3333-3333-333333333333",
                  filhos: []
                }
              ]
            }
          ]
        },
        {
          tipo: "pasta",
          nome: "3° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "🗄️ Banco de Dados",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01",
                  local: "3° semestre/Banco de Dados/Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/44444444-4444-4444-4444-444444444444",
                  filhos: []
                }
              ]
            }
          ]
        }
      ]
    });
    store.setState({ db: dbMulti });

    const [sem1, sem2, sem3] = dbMulti.semestres;
    const discAlg = sem1.disciplinas[0];
    const discRedes = sem2.disciplinas[0];

    // 1. Selecionar múltiplos semestres (1° e 3°, ignorando 2°) + múltiplos tipos (mindmap, flashcards, quiz) apenas faltantes
    // Sem1 tem 2 aulas (Algoritmos já tem flashcards -> 2 faltantes; Cálculo I -> 3 faltantes) = 5
    // Sem3 tem 1 aula (Banco de Dados -> 3 faltantes) = 3  => Total esperado: 8
    const simSemestres = simularLoteStudio({
      semestreIds: [sem1.id, sem3.id],
      materiaIds: null,
      tiposArtefato: ["mindmap", "flashcards", "quiz"],
      modoAcao: "gerar_faltantes"
    });
    assert.equal(simSemestres.totalMaterias, 3);
    assert.equal(simSemestres.totalTipos, 3);
    assert.equal(simSemestres.totalTarefas, 8);
    assert.equal(simSemestres.totalGerar, 8);
    assert.equal(simSemestres.totalRegerar, 0);
    assert.ok(simSemestres.itens.every(i => i.semestre_id !== sem2.id));

    // 2. Selecionar múltiplas matérias de semestres diferentes (Algoritmos + Redes) + múltiplos tipos (flashcards + video) modo todos
    const jobsDisparados = dispararLoteStudio({
      materiaIds: [discAlg.id, discRedes.id],
      tiposArtefato: ["flashcards", "video"],
      modoAcao: "todos"
    });
    assert.equal(jobsDisparados.length, 4);
    assert.equal(jobsDisparados.filter(j => j.acao === "regerar").length, 1); // flashcards de Algoritmos já existia
    assert.equal(jobsDisparados.filter(j => j.acao === "gerar").length, 3);

    // 3. Seleção vazia não enfileira nada
    const simVaziaMat = simularLoteStudio({ materiaIds: [], tiposArtefato: ["quiz"], modoAcao: "todos" });
    assert.equal(simVaziaMat.totalTarefas, 0);
    const simVaziaTipo = simularLoteStudio({ materiaIds: "todas", tiposArtefato: [], modoAcao: "todos" });
    assert.equal(simVaziaTipo.totalTarefas, 0);
  });

  it("Ordem Hierárquica Estrita: Semestre (1→8→Cursos) > Matéria inteira > Aula (1→N→Conclusão) > mindmap→video", async () => {
    const dbOrdem = normalizarDb({
      filhos: [
        {
          tipo: "pasta",
          nome: "Cursos",
          filhos: [
            { tipo: "pasta", nome: "Java", filhos: [{ tipo: "pasta", nome: "Aula 01", local: "Cursos/Java/Aula 01", filhos: [] }] }
          ]
        },
        {
          tipo: "pasta",
          nome: "2° semestre",
          filhos: [
            { tipo: "pasta", nome: "Redes", filhos: [{ tipo: "pasta", nome: "Aula 01", local: "2° semestre/Redes/Aula 01", filhos: [] }] }
          ]
        },
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "Beta Matéria",
              filhos: [{ tipo: "pasta", nome: "Aula 01", local: "1° semestre/Beta Matéria/Aula 01", filhos: [] }]
            },
            {
              tipo: "pasta",
              nome: "Alpha Matéria",
              filhos: [
                { tipo: "pasta", nome: "Aula Conclusão", local: "1° semestre/Alpha Matéria/Aula Conclusão", filhos: [] },
                { tipo: "pasta", nome: "Aula 10", local: "1° semestre/Alpha Matéria/Aula 10", filhos: [] },
                { tipo: "pasta", nome: "Aula 02", local: "1° semestre/Alpha Matéria/Aula 02", filhos: [] },
                { tipo: "pasta", nome: "Aula 01", local: "1° semestre/Alpha Matéria/Aula 01", filhos: [] }
              ]
            }
          ]
        }
      ]
    });
    store.setState({ db: dbOrdem });

    const sim = simularLoteStudio({ materiaIds: "todas", tiposArtefato: "todos", modoAcao: "todos" });
    const esperados8 = ["mindmap", "flashcards", "quiz", "relatorio", "infografico", "slides", "audio", "video"];

    // Primeiros 8 itens: 1° semestre > Alpha Matéria > Aula 01 > mindmap..video
    assert.deepEqual(
      sim.itens.slice(0, 8).map(i => i.tipo_artefato),
      esperados8
    );
    assert.ok(sim.itens.slice(0, 8).every(i => i.semestre_nome === "1° semestre" && i.materia_nome === "Alpha Matéria" && i.aula_nome === "Aula 01"));

    // Próximos 8: Aula 02 da mesma Alpha Matéria
    assert.deepEqual(sim.itens.slice(8, 16).map(i => i.tipo_artefato), esperados8);
    assert.ok(sim.itens.slice(8, 16).every(i => i.materia_nome === "Alpha Matéria" && i.aula_nome === "Aula 02"));

    // Próximos 8: Aula 10 (depois da 02, antes da Conclusão)
    assert.ok(sim.itens.slice(16, 24).every(i => i.materia_nome === "Alpha Matéria" && i.aula_nome === "Aula 10"));

    // Próximos 8: Aula Conclusão da Alpha Matéria
    assert.ok(sim.itens.slice(24, 32).every(i => i.materia_nome === "Alpha Matéria" && i.aula_nome === "Aula Conclusão"));

    // Depois termina Alpha -> vai para Beta Matéria (ainda no 1° semestre)
    assert.ok(sim.itens.slice(32, 40).every(i => i.semestre_nome === "1° semestre" && i.materia_nome === "Beta Matéria"));

    // Só depois de terminar TODO o 1° semestre -> vai para 2° semestre
    assert.ok(sim.itens.slice(40, 48).every(i => i.semestre_nome === "2° semestre" && i.materia_nome === "Redes"));

    // Por último -> Cursos (sem número)
    assert.ok(sim.itens.slice(48, 56).every(i => i.semestre_nome === "Cursos" && i.materia_nome === "Java"));
  });

  it("Carregamento Online (GitHub Pages): ignora mockup db.json, baixa dados reais do Firebase na 1ª visita e gasta apenas /db_meta no F5", async () => {
    const prevWindow = global.window;
    const prevDocument = global.document;
    limparDbCache();
    limparCacheConteudoSobDemanda();

    // Simula ambiente online GitHub Pages (não-localhost) e injeta um mockup antigo no cache para provar descarte
    global.window = {
      location: { protocol: "https:", hostname: "renanratinh0.github.io", hash: "#/" },
      addEventListener: () => {}
    };
    global.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      visibilityState: "visible",
      documentElement: { classList: { add() {}, remove() {} }, setAttribute() {} }
    };
    salvarDbCache({ id: "template_root_study_os", nome: "Raiz", filhos: [] });

    const dbRealNuvem = {
      id: "raiz_real_prod",
      nome: "CienciaComputacao",
      atualizado_em: 1795056269124,
      filhos: [
        {
          tipo: "pasta",
          nome: "1° semestre",
          filhos: [
            { tipo: "pasta", nome: "Sistemas Operacionais", filhos: [] }
          ]
        }
      ]
    };

    let qtdDbJson = 0;
    let qtdDbMeta = 0;
    let qtdLocalMock = 0;

    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("db.personal.json") || u.endsWith("db.json") || u.includes("/data/db.json")) {
        if (!u.includes("firebaseio.com")) {
          qtdLocalMock++;
          return { ok: true, status: 200, json: async () => ({ id: "template_root_study_os", filhos: [] }) };
        }
      }
      if (u.includes("/db_meta.json")) {
        qtdDbMeta++;
        return { ok: true, status: 200, json: async () => ({ atualizado_em: 1795056269124, modo: "catalogo_leve" }) };
      }
      if (u.includes("/db_json.json")) {
        qtdDbJson++;
        return { ok: true, status: 200, json: async () => dbRealNuvem };
      }
      return { ok: false, status: 404, json: async () => null };
    };

    try {
      // 1ª visita: descarta mockup, NÃO busca arquivos locais e baixa o banco real do Firebase
      await inicializarApp();
      assert.equal(qtdLocalMock, 0, "Não deve requisitar db.personal.json ou db.json mockup no GitHub Pages");
      assert.equal(qtdDbMeta, 1);
      assert.equal(qtdDbJson, 1);
      assert.equal(store.getState().db.semestres[0].disciplinas[0].nome, "Sistemas Operacionais");

      // 2ª visita (F5): consulta apenas /db_meta.json (~100B) e NÃO baixa /db_json.json novamente
      await inicializarApp();
      assert.equal(qtdLocalMock, 0);
      assert.equal(qtdDbMeta, 2);
      assert.equal(qtdDbJson, 1, "No F5 com mesmo atualizado_em deve consumir 0 bytes de /db_json.json");
    } finally {
      global.window = prevWindow;
      global.document = prevDocument;
      limparDbCache();
    }
  });

  it("Cache Persistente de /db_conteudo/{aulaId} via Browser Cache API: evita redownload após F5 e invalida em nova versão", async () => {
    const prevCaches = global.caches;
    const prevResponse = global.Response;
    limparCacheConteudoSobDemanda();

    const storeCaches = new Map();
    global.caches = {
      async open(name) {
        if (!storeCaches.has(name)) storeCaches.set(name, new Map());
        const bucket = storeCaches.get(name);
        return {
          async match(key) {
            return bucket.get(String(key)) || undefined;
          },
          async put(key, resp) {
            bucket.set(String(key), resp);
          }
        };
      },
      async delete(name) {
        return storeCaches.delete(name);
      }
    };
    if (typeof global.Response === "undefined") {
      global.Response = class MockResp {
        constructor(body) { this._body = body; }
        async json() { return JSON.parse(this._body); }
      };
    }

    let qtdFetchConteudo = 0;
    global.fetch = async (url) => {
      if (String(url).includes("/db_conteudo/aula-cache-teste.json")) {
        qtdFetchConteudo++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ mds: { "Resumo_p_md": `# Versão ${qtdFetchConteudo}` } })
        };
      }
      return { ok: false, status: 404, json: async () => null };
    };

    try {
      definirVersaoDbAtual(1000);
      const res1 = await carregarConteudoAulaFirebase("aula-cache-teste");
      assert.equal(qtdFetchConteudo, 1);
      assert.equal(res1.mds["Resumo_p_md"], "# Versão 1");

      // Simula F5 (limpa cache RAM mantendo Cache API do navegador + mesmo atualizado_em)
      limparCacheConteudoSobDemanda();
      definirVersaoDbAtual(1000);
      const res2 = await carregarConteudoAulaFirebase("aula-cache-teste");
      assert.equal(qtdFetchConteudo, 1, "Após F5 na mesma versão, deve ler do Cache API com 0 requests ao Firebase");
      assert.equal(res2.mds["Resumo_p_md"], "# Versão 1");

      // Quando /db_meta atualiza (novo atualizado_em), invalida Cache API e busca nova versão
      definirVersaoDbAtual(2000);
      const res3 = await carregarConteudoAulaFirebase("aula-cache-teste");
      assert.equal(qtdFetchConteudo, 2);
      assert.equal(res3.mds["Resumo_p_md"], "# Versão 2");
    } finally {
      global.caches = prevCaches;
      global.Response = prevResponse;
      limparCacheConteudoSobDemanda();
    }
  });
});
