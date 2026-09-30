# Fase 6.1 - Fundacao do Endgame Lv40

## Objetivo
Criar uma progressao paralela para personagens no nivel maximo sem criar nivel 41 e sem alterar o balanceamento de atributos da Fase 5.17.

## Estado persistente
O save passa a conter endgame com tres campos: rank de Maestria, XP de Maestria e Essencia.

## Regras
- Level cap continua 40.
- Personagem abaixo do Lv40 nao ganha XP de Maestria.
- Maestria inicia no rank 0 e tem teto 100 nesta fase.
- A curva inicia em 1000 XP e cresce 8% por rank.
- Maestria nao concede stats diretamente na 6.1.
- Essencia e a moeda/material reservado ao endgame, com teto de seguranca.
- O estado endgame e sanitizado no servidor e bloqueado no PUT generico do personagem.

## Compatibilidade
Personagens existentes sem o campo endgame recebem automaticamente o estado inicial ao passar pela sanitizacao do save. Nenhuma migration SQL e necessaria porque o save atual e JSON persistido.

## Proximos passos da 6.1
Adicionar contadores de recompensa endgame proprios e conceder Maestria/Essencia por atividades Lv40 elegiveis, sem reutilizar ambiguamente os contadores de XP normal da Fase 5.17.
