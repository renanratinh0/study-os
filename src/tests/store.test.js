import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  store,
  normalizarDb,
  converterArquivoNode,
  converterDisciplinaNode,
  calcularEstatisticasDb,
  obterTodasDisciplinas,
  buscarDisciplinaPorId,
  calcularStatusAula,
  normalizarLinkNotebook,
  extrairDriveIdDeLink,
  verificarLinkNotebookDuplicado,
  auditarLinksNotebookLLM
} from "../core/store.js";

describe("Store & Normalization Suite", () => {
  it("deve inicializar o store com o estado reativo padrão", () => {
    const state = store.getState();
    assert.ok(state !== null);
    assert.equal(state.databaseViewMode, "gallery");
    assert.equal(state.filtroSemestreAtivo, "todos");
    assert.equal(state.filtroStatusAtivo, "todos");
  });

  it("deve notificar ouvintes ao chamar setState", () => {
    let notified = false;
    const unsubscribe = store.subscribe((newState) => {
      if (newState.filtroStatusAtivo === "Aprovado") {
        notified = true;
      }
    });

    store.setState({ filtroStatusAtivo: "Aprovado" });
    assert.equal(notified, true);
    assert.equal(store.getState().filtroStatusAtivo, "Aprovado");

    // Cleanup
    unsubscribe();
    store.setState({ filtroStatusAtivo: "todos" });
  });

  it("deve normalizar banco de dados nulo para a estrutura vazia padrão", () => {
    const db = normalizarDb(null);
    assert.equal(db.usuario, "Renan");
    assert.equal(db.curso, "Ciência da Computação");
    assert.deepEqual(db.semestres, []);
  });

  it("deve normalizar árvore crua com 'filhos' do Google Drive", () => {
    const rawDrive = {
      usuario: "Renan",
      curso: "Ciência da Computação",
      filhos: [
        {
          tipo: "pasta",
          nome: "1º Semestre",
          filhos: [
            {
              tipo: "pasta",
              nome: "Algoritmos e Estruturas de Dados",
              prof: "Prof. Alan Turing",
              Status: "Aprovado",
              TAGS: "Computação, Obrigatória",
              filhos: [
                {
                  tipo: "pasta",
                  nome: "Aula 01 - Introdução aos Grafos",
                  data_aula: "2026-03-10",
                  presenca: true,
                  revisao: false,
                  linkNotebookLLM: "https://notebooklm.google.com/test",
                  filhos: [
                    {
                      nome: "resumo.md",
                      conteudoTexto: "# Introdução aos Grafos\nConteúdo da aula..."
                    },
                    {
                      nome: "slides.pdf",
                      id: "1abc2def3ghi4jkl5mno",
                      temOCR: false
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const dbNorm = normalizarDb(rawDrive);
    assert.equal(dbNorm.semestres.length, 1);
    const sem = dbNorm.semestres[0];
    assert.equal(sem.nome, "1º Semestre");
    assert.equal(sem.disciplinas.length, 1);

    const disc = sem.disciplinas[0];
    assert.equal(disc.nome, "Algoritmos e Estruturas de Dados");
    assert.equal(disc.prof, "Prof. Alan Turing");
    assert.equal(disc.status, "Aprovado");
    assert.deepEqual(disc.TAGS, ["Computação", "Obrigatória"]);
    assert.equal(disc.aulas.length, 1);

    const aula = disc.aulas[0];
    assert.equal(aula.nome, "Aula 01 - Introdução aos Grafos");
    assert.equal(aula.presenca, true);
    assert.equal(aula.arquivos.length, 2);
  });

  it("deve calcular estatísticas agregadas do banco com acurácia", () => {
    const mockDb = {
      semestres: [
        {
          id: "sem-1",
          nome: "1º Semestre",
          disciplinas: [
            {
              id: "disc-1",
              nome: "Cálculo 1",
              status: "Aprovado",
              aulas: [
                {
                  id: "aula-1",
                  nome: "Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/c1",
                  arquivos: [
                    { tipo: "md", driveId: "123456789012" },
                    { tipo: "pdf", temOCR: false, driveId: "123456789013" },
                    { tipo: "mp4", driveId: "123456789014" }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const stats = calcularEstatisticasDb(mockDb);
    assert.equal(stats.semestres, 1);
    assert.equal(stats.disciplinas, 1);
    assert.equal(stats.aulas, 1);
    assert.equal(stats.aulasComNotebook, 1);
    assert.equal(stats.arquivosTotal, 3);
    assert.equal(stats.arquivosComDriveId, 3);
    assert.equal(stats.pdfsSemOcr, 1);
    assert.equal(stats.porStatus.aprovado, 1);
  });

  it("deve calcular corretamente o status da aula (presença, falta, revisão)", () => {
    // Aula passada com presença
    const stPresenca = calcularStatusAula({
      data_aula: "2020-01-01",
      presenca: true,
      revisao: true
    });
    assert.equal(stPresenca.presenca, true);
    assert.equal(stPresenca.falta, false);
    assert.equal(stPresenca.revisao, true);

    // Aula passada sem presença -> FALTA
    const stFalta = calcularStatusAula({
      data_aula: "2020-01-01",
      presenca: false,
      revisao: false
    });
    assert.equal(stFalta.presenca, false);
    assert.equal(stFalta.falta, true);

    // Aula sem data
    const stSemData = calcularStatusAula({
      data_aula: "",
      presenca: false
    });
    assert.equal(stSemData.temData, false);
    assert.equal(stSemData.falta, false);
  });

  it("deve buscar disciplina por id ou slug", () => {
    const mockDb = {
      semestres: [
        {
          id: "sem-1",
          nome: "1º Semestre",
          disciplinas: [
            { id: "computacao-grafica", nome: "Computação Gráfica" }
          ]
        }
      ]
    };

    const disc = buscarDisciplinaPorId("computacao-grafica", mockDb);
    assert.ok(disc !== null);
    assert.equal(disc.nome, "Computação Gráfica");
    assert.equal(disc.semestreNome, "1º Semestre");

    const naoExiste = buscarDisciplinaPorId("inexistente", mockDb);
    assert.equal(naoExiste, null);
  });

  it("deve normalizar links de NotebookLM removendo query params e trailing slashes", () => {
    assert.equal(
      normalizarLinkNotebook("https://notebooklm.google.com/notebook/12345678-abcd?authuser=1&hl=pt-br/"),
      "https://notebooklm.google.com/notebook/12345678-abcd"
    );
    assert.equal(normalizarLinkNotebook(""), "");
    assert.equal(normalizarLinkNotebook(null), "");
  });

  it("deve extrair com sucesso Drive ID de links ou IDs puros", () => {
    // ID puro
    assert.equal(extrairDriveIdDeLink("1a2b3c4d5e6f7g8h9i0j"), "1a2b3c4d5e6f7g8h9i0j");
    // Link de pasta
    assert.equal(
      extrairDriveIdDeLink("https://drive.google.com/drive/folders/1abc987xyz654_teste-123?usp=sharing"),
      "1abc987xyz654_teste-123"
    );
    // Link de arquivo
    assert.equal(
      extrairDriveIdDeLink("https://drive.google.com/file/d/1_FileID-xyz789ABC/view?usp=sharing"),
      "1_FileID-xyz789ABC"
    );
    // Link open?id=
    assert.equal(
      extrairDriveIdDeLink("https://drive.google.com/open?id=1OpenIdXYZ123456"),
      "1OpenIdXYZ123456"
    );
  });

  it("deve detectar links duplicados de NotebookLM entre aulas e matérias diferentes", () => {
    const mockDbComDuplicatas = {
      semestres: [
        {
          id: "sem-1",
          nome: "1º Semestre",
          disciplinas: [
            {
              id: "disc-a",
              nome: "Algoritmos",
              aulas: [
                {
                  id: "aula-1",
                  nome: "Aula 01",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/xyz-compartilhado?hl=pt"
                },
                {
                  id: "aula-2",
                  nome: "Aula 02",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/xyz-compartilhado"
                }
              ]
            },
            {
              id: "disc-b",
              nome: "Estruturas de Dados",
              aulas: [
                {
                  id: "aula-x",
                  nome: "Aula Especial",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/xyz-compartilhado/"
                },
                {
                  id: "aula-y",
                  nome: "Aula Única",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/outro-caderno"
                }
              ]
            }
          ]
        }
      ]
    };

    // Verificando a partir de aula-1
    const resA1 = verificarLinkNotebookDuplicado(
      "https://notebooklm.google.com/notebook/xyz-compartilhado",
      "disc-a",
      "aula-1",
      mockDbComDuplicatas
    );
    assert.equal(resA1.duplicado, true);
    assert.equal(resA1.totalOcorrencias, 3);
    assert.equal(resA1.outrasAulas.length, 2);
    assert.ok(resA1.outrasAulas.some(o => o.discNome === "Estruturas de Dados" && o.aulaNome === "Aula Especial"));

    // Verificando caderno único sem duplicata
    const resUnico = verificarLinkNotebookDuplicado(
      "https://notebooklm.google.com/notebook/outro-caderno",
      "disc-b",
      "aula-y",
      mockDbComDuplicatas
    );
    assert.equal(resUnico.duplicado, false);
    assert.equal(resUnico.totalOcorrencias, 1);
    assert.equal(resUnico.outrasAulas.length, 0);

    // Auditoria global
    const auditoria = auditarLinksNotebookLLM(mockDbComDuplicatas);
    assert.equal(auditoria.totalComLink, 4);
    assert.equal(auditoria.totalLinksUnicos, 2);
    assert.equal(auditoria.duplicatas.length, 1);
    assert.equal(auditoria.duplicatas[0].aulas.length, 3);
  });

  it("deve preservar linkDrive e extrair driveId na normalização da aula", () => {
    const rawData = {
      usuario: "Renan",
      curso: "Ciência da Computação",
      semestres: [
        {
          id: "sem-1",
          nome: "1º Semestre",
          disciplinas: [
            {
              id: "disc-1",
              nome: "Matemática",
              aulas: [
                {
                  id: "aula-drive",
                  nome: "Aula com Drive",
                  linkDrive: "https://drive.google.com/drive/folders/1FolderID12345",
                  linkNotebookLLM: "https://notebooklm.google.com/notebook/nb-1"
                }
              ]
            }
          ]
        }
      ]
    };

    const dbNorm = normalizarDb(rawData);
    const aula = dbNorm.semestres[0].disciplinas[0].aulas[0];
    assert.equal(aula.linkDrive, "https://drive.google.com/drive/folders/1FolderID12345");
    assert.equal(aula.driveId, "1FolderID12345");
    assert.equal(aula.linkNotebookLLM, "https://notebooklm.google.com/notebook/nb-1");
  });

  it("deve normalizar, deduplicar, filtrar redundâncias de pasta e ordenar tags semanticamente", async () => {
    const { parsearTagsDisciplina } = await import("../utils/domHelpers.js");
    const { ehTagRedundanteDePasta, ordenarTagsSemanticamente, formatarTagPillHtml } = await import("../components/DisciplineCard.js");

    const brutas = ["705", "D", "Quinta feira", "Cursos", "Curso", "2026", "1° semestre", "LAB.INF.2", "EAD", "ALFA"];
    const norm = parsearTagsDisciplina(brutas);

    assert.deepEqual(norm, ["Sala 705", "Bloco D", "Quinta", "Curso", "2026", "1° semestre", "LAB.INF.2", "EAD", "Bloco ALFA"]);

    const semPasta = norm.filter(t => !ehTagRedundanteDePasta(t));
    assert.ok(!semPasta.includes("Curso"));
    assert.ok(!semPasta.includes("1° semestre"));

    const ordenadas = ordenarTagsSemanticamente(semPasta);
    assert.deepEqual(ordenadas, ["2026", "EAD", "Quinta", "Bloco ALFA", "Bloco D", "LAB.INF.2", "Sala 705"]);

    assert.ok(formatarTagPillHtml("Bloco D").includes("🏢"));
    assert.ok(formatarTagPillHtml("Sala 705").includes("🚪"));
    assert.ok(formatarTagPillHtml("LAB.INF.2").includes("🖥️"));
  });

  it("deve ter sempre o tema escuro ('dark') como padrão e permitir alternar para claro ('light')", async () => {
    const { DEFAULT_THEME } = await import("../core/constants.js");
    const { obterTemaPreferido, salvarTemaPreferido, alternarTema } = await import("../services/storage.js");

    assert.equal(DEFAULT_THEME, "dark");
    assert.equal(obterTemaPreferido(), "dark");

    // Alternar de dark -> light
    const paraClaro = alternarTema();
    assert.equal(paraClaro, "light");
    assert.equal(obterTemaPreferido(), "light");

    // Alternar de light -> dark
    const paraEscuro = alternarTema();
    assert.equal(paraEscuro, "dark");
    assert.equal(obterTemaPreferido(), "dark");

    // Qualquer valor inválido deve recair sempre no padrão "dark"
    assert.equal(salvarTemaPreferido("invalido"), "dark");
    assert.equal(obterTemaPreferido(), "dark");
  });
});

