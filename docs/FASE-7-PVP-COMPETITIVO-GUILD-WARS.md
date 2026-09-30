# Fase 7 - PvP Competitivo e Guild Wars

## 7.1 Rating e divisoes
Rating server-authoritative 0-3000, Elo, Bronze/Silver/Gold/Platinum/Diamond/Master. Cinco partidas de colocacao usam K maior.

## 7.2 Temporadas
Temporadas de 28 dias. A troca de temporada reinicia rating competitivo em 1000 e W/L/D da temporada, preservando bestRating historico.

## 7.3 Arena
Contrato para Duelo 1v1, Trio 3v3 e Guild War 5v5. O combate reutiliza a autoridade e PowerScore existentes no TvT; rating nunca altera dano, HP ou stats.

## 7.4 Matchmaking
Criterio combina distancia de rating e PowerScore exclusivamente para pareamento. PowerScore permanece fora das formulas de combate.

## 7.5 Guild Wars
Roster valido de 3 a 5 membros unicos, modo competitivo 5v5, desafio com TTL de 10 minutos e limite de cinco guerras recompensadas por semana. A base de Guildas da Fase 5.8 permanece intacta.

## 7.6 Integridade competitiva
competitive fica dentro do save sanitizado e no ECONOMY_LOCK_FIELDS. Cliente generico nao pode forjar rating, temporada, vitorias ou recompensas.

## 7.7 Integracao
O modulo competitive-data.js e puro, testavel e exportado pelo servidor. Guildas e TvT existentes continuam compativeis; Fase 6 Endgame e economia PvE nao sao usadas para comprar rating nem vantagem competitiva.

## Escopo tecnico
Esta fase estabelece o backend/contrato competitivo completo sobre os sistemas PvP e Guild existentes. Interfaces visuais podem consumir o estado competitivo sem possuir autoridade.
