# Fase 6 - Endgame Lv40

## 6.1 Fundacao
Lv40 permanece cap absoluto. Maestria 0-100 e Essencia formam progressao paralela persistida em save.endgame e protegida pelo servidor.

## 6.2 Talentos
Quatro arvores independentes: Guerreiro, Arqueiro, Mago e Druida. Um ponto a cada 5 ranks de Maestria, maximo 5 por talento. O servidor valida classe, disponibilidade e teto.

## 6.3 Sets Endgame
Contrato de bonus 2/4/6 pecas. Dois itens ativam HP, quatro ativam ataque/defesa e seis completam o bonus. O contrato fica centralizado no modulo endgame para consumo pelo combate/equipamentos.

## 6.4 Dungeon Endgame
Dificuldades Normal, Hard, Heroic e Mythic. Gates de Maestria 0/5/15/30 e multiplicadores crescentes de HP, dano, Maestria e Essencia. Recompensa Lv40 usa contadores endgame separados.

## 6.5 World Boss Endgame
No Lv40 o World Boss concede Maestria e Essencia em paralelo a recompensa historica. Limites endgame sao independentes: Maestria diaria e Essencia semanal.

## 6.6 Reputacao
Oito regioes possuem reputacao 0-15000 e patamares Neutral, Friendly, Honored, Revered e Exalted. A estrutura e server-authoritative e preparada para recompensas regionais.

## 6.7 Integracao
save.endgame e sanitizado em toda leitura e bloqueado no PUT generico. Personagens antigos recebem defaults sem migration SQL. Recompensas de Dungeon/World Boss retornam estado endgame ao cliente. O modulo e puro/testavel e exportado pelo servidor para regressao.

## Compatibilidade
Nenhum Lv41. Nenhuma alteracao destrutiva no schema. XP, gemas, enchant, loot, Party, Guild, TvT, Living World e eventos 5.x continuam independentes.
