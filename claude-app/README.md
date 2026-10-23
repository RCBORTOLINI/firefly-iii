# Vagalume — finanças pessoais no Claude

Adaptação do [Firefly III](https://github.com/firefly-iii/firefly-iii) para rodar como página do Claude
(claude.ai), sem servidor próprio. Interface em português do Brasil e valores em reais (R$).

## O que foi reaproveitado do Firefly III

- **Modelo de dados:** contas por tipo (ativo, despesa, receita, passivo), lançamentos em partidas
  dobradas (despesa, receita, transferência), categorias, orçamentos com limite por mês,
  contas recorrentes, lançamentos recorrentes, cofrinhos, tags e regras (condições e ações).
- **Telas:** painel, lançamentos, contas, orçamentos, categorias, tags, contas recorrentes,
  recorrências, cofrinhos, regras e relatórios.
- **Regras de negócio:** o tipo do lançamento vem dos tipos das contas, os saldos são a soma das
  movimentações, contas de despesa e receita são criadas ao digitar um nome novo, a conta
  recorrente pode criar uma regra para vincular os pagamentos sozinha e as regras rodam em ordem,
  com opção de parar as seguintes.

Nada do PHP/Laravel roda aqui. A lógica foi reescrita em JavaScript em `core.js`.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `index.html` | Estrutura da página e estilos (visual de app de iPhone, tema claro e escuro) |
| `core.js` | Regras de negócio puras: dinheiro, datas, saldos, orçamentos, contas recorrentes, recorrências, regras, relatórios, backup |
| `app.js` | Telas, formulários, gráficos e gravação no banco de dados do Claude |
| `tests/core.test.js` | Testes do `core.js` — rode com `node --test claude-app/tests/core.test.js` |

## Onde os dados ficam

No banco de dados da página do Claude, em `data/users/<seu id>/`. A plataforma mantém essa área
privada: só você lê e grava, nem o dono da página nem o Claude enxergam. São um documento por tipo
de cadastro (`accounts`, `categories`, `budgets`, `bills`, `recurrences`, `piggies`, `rules`) e um
documento por mês de lançamentos (`tx-AAAA-MM`). Use **Mais → Backup** para exportar um `.json`.

Fora do claude.ai (por exemplo, abrindo o `index.html` direto no navegador), o app mostra dados de
exemplo e não salva nada.

## Diferenças em relação ao Firefly III

Ficaram de fora: multimoeda e câmbio, lançamentos divididos, anexos, webhooks, e-mails, importação
de extratos, vários usuários, API e grupos de regras. Os cofrinhos ficam ligados a uma conta só.
Lançamentos recorrentes são criados quando você abre o app, não por cron.

## Licença

Firefly III: Copyright (c) James Cole <james@firefly-iii.org> e colaboradores.
Modificações: Copyright (c) 2026 rcbortolini.

Este programa é software livre, distribuído sob a GNU Affero General Public License, versão 3 ou
posterior (veja o arquivo `LICENSE` na raiz do repositório). Como a AGPL exige, o app publicado
traz, na tela **Sobre**, o link para este código-fonte.
