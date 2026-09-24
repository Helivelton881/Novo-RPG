'use strict';
// Fase 5.9 -- Bestiario: catalogo canonico dos monstros/chefes que
// realmente existem no jogo. So metadados descritivos (nome de exibicao,
// regiao, faixa de nivel, descricao, categorias de drop possiveis) --
// stats numericos (hp/dano/xp) continuam vindo so de mobStats() em
// server.js e nunca sao duplicados aqui (evita duas fontes divergentes).
// IDs espelham exatamente os `type` reais usados em mobStats/MOB_AI_STEP/
// DUNGEON_CFG (server.js) + WORLD_BOSS_MAP_RE ('ancient_titan').

const BESTIARY_CATALOG = Object.freeze([
  { id: 'slime',        displayName: 'Slime',            region: 'Vila Inicial',  levelRange: '1-4',   boss: false, dropTiers: ['basic'] },
  { id: 'goblin',       displayName: 'Goblin',           region: 'Floresta',      levelRange: '5-10',  boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'skeleton',     displayName: 'Esqueleto',        region: 'Cripta',        levelRange: '10-15', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'wolf',         displayName: 'Lobo',             region: 'Serra',         levelRange: '15-20', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'bat',          displayName: 'Morcego',          region: 'Serra / Pântano', levelRange: '20-30', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'toxic',        displayName: 'Criatura Tóxica',  region: 'Pântano',       levelRange: '20-25', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'caster',       displayName: 'Conjurador',       region: 'Torre',         levelRange: '25-30', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'sky',          displayName: 'Guardião do Céu',  region: 'Ilhas',         levelRange: '30-35', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'sala',         displayName: 'Salamandra',       region: 'Vulcão',        levelRange: '36-39', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'elem',         displayName: 'Elemental',        region: 'Vulcão',        levelRange: '36-39', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'calc',         displayName: 'Calcinado',        region: 'Vulcão',        levelRange: '36-39', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'cinza',        displayName: 'Ser de Cinzas',    region: 'Vulcão',        levelRange: '36-39', boss: false, dropTiers: ['basic', 'rare', 'epic'] },
  { id: 'lorde',        displayName: 'Lorde do Vulcão',  region: 'Vulcão (Chefe)', levelRange: '40',    boss: true,  dropTiers: ['basic', 'rare', 'epic', 'legendary'] },
  { id: 'ancient_titan', displayName: 'Titã Ancestral',  region: 'World Boss',    levelRange: '40',    boss: true,  dropTiers: ['legendary'] },
]);

const BESTIARY_TOTAL = BESTIARY_CATALOG.length;
const BESTIARY_IDS = new Set(BESTIARY_CATALOG.map(c => c.id));
const BESTIARY_BY_ID = new Map(BESTIARY_CATALOG.map(c => [c.id, c]));

function isValidMonsterId(id) { return BESTIARY_IDS.has(id); }
function catalogEntry(id) { return BESTIARY_BY_ID.get(id) || null; }

module.exports = { BESTIARY_CATALOG, BESTIARY_TOTAL, BESTIARY_IDS, isValidMonsterId, catalogEntry };
