'use strict';
// Fase 5.11 -- Mercado/Leilao: nucleo puro (config, taxa, validacao de
// preco/filtros). A logica critica de escrow/compra/claim vive nas
// funcoes RPC do Postgres (ver supabase/migrations/*_add_market_tables_
// and_functions.sql) -- aqui so o que e testavel sem banco.

const MARKET_MIN_PRICE = 1;
const MARKET_MAX_PRICE = 500000; // mesmo teto de save.gold (sanitizeSave)
const MARKET_FEE_RATE = 0.05;
const MARKET_LISTING_DURATION_MS = 72 * 60 * 60 * 1000;
const MARKET_PAGE_SIZE = 20;

function isValidPrice(price) {
  const p = Math.round(Number(price));
  return Number.isFinite(p) && p >= MARKET_MIN_PRICE && p <= MARKET_MAX_PRICE;
}
// Espelha exatamente floor(price*0.05) que a funcao SQL market_buy usa --
// mantido aqui so pra pre-visualizacao no cliente (preco liquido antes de
// anunciar); o valor que realmente vale e sempre o computado no Postgres.
function feeFor(price) {
  const fee = Math.floor(price * MARKET_FEE_RATE);
  return { fee, netReceived: price - fee };
}

const MARKET_SORTS = Object.freeze(['price_asc', 'price_desc', 'newest', 'enchant_desc']);
function isValidSort(sort) { return MARKET_SORTS.includes(sort); }

module.exports = {
  MARKET_MIN_PRICE, MARKET_MAX_PRICE, MARKET_FEE_RATE, MARKET_LISTING_DURATION_MS, MARKET_PAGE_SIZE,
  isValidPrice, feeFor, MARKET_SORTS, isValidSort,
};
