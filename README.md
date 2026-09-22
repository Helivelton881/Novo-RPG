# MMORPG: Vila Inicial — multiplayer MVP

Este projeto adiciona presença multiplayer real ao protótipo existente.

## Incluído

- servidor HTTP e WebSocket;
- jogadores remotos no mesmo mapa;
- posição, direção, animação, classe e nível sincronizados;
- entrada, saída e reconexão;
- contador de jogadores online;
- validação básica e heartbeat no servidor.
- HP, dano, morte e respawn de monstros compartilhados;
- uma autoridade de movimentação dos monstros por mapa, com troca automática quando ela desconecta;
- posições e estados de IA replicados para os demais jogadores;
- layout determinístico das masmorras para todos entrarem no mesmo labirinto.

O servidor já arbitra o HP e a morte dos monstros. Inventário, progressão, cálculo do dano e parte da IA ainda precisam migrar integralmente para o servidor antes de uma versão pública competitiva.

## Executar

```powershell
npm install
npm start
```

Abra `http://localhost:8080` em dois navegadores ou dispositivos da mesma rede.

Para publicar, configure `PORT` na hospedagem e use um serviço compatível com WebSocket.
