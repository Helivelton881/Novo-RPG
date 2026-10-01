'use strict';
(function(g){
 const divisions=[['bronze',0],['silver',900],['gold',1200],['platinum',1500],['diamond',1800],['master',2100]];
 function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
 function division(r){let x=divisions[0][0];for(const d of divisions)if((+r||0)>=d[1])x=d[0];return x}
 function render(state,tab='arena'){
  const c=state||{},rating=+c.rating||0,div=division(rating),season=esc(c.season||'Temporada atual');
  const head='<i class="orn"></i><header class="rh"><div class="ttl"><h3>Mestre do PvP</h3><small>'+season+' · '+div.toUpperCase()+' · Rating '+rating+'</small></div><button class="rx" data-arena-close aria-label="Fechar">×</button></header>';
  const tabs=['arena','3v3','guild','ranking','rewards'].map(x=>'<button data-arena-tab="'+x+'" class="'+(tab===x?'on':'')+'">'+({arena:'Arena','3v3':'3v3',guild:'Guild',ranking:'Ranking',rewards:'Prêmios'}[x])+'</button>').join('');
  let body='';
  if(tab==='arena')body='<section class="arenaHero"><h2>'+div.toUpperCase()+'</h2><strong>Rating '+rating+'</strong><p>'+(+c.wins||0)+' vitórias · '+(+c.losses||0)+' derrotas · '+(+c.draws||0)+' empates</p><button class="arenaPrimary" data-arena-queue="duel">PROCURAR DUELO 1x1</button></section>';
  if(tab==='3v3')body='<section><h2>Arena 3x3</h2><p>Monte um grupo de três jogadores. O pareamento usa Rating e PowerScore sem alterar os atributos de combate.</p><button class="arenaPrimary" data-arena-queue="trio">PROCURAR PARTIDA 3x3</button></section>';
  if(tab==='guild')body='<section><h2>Guerra de Guildas 5x5</h2><p>Equipe válida: 3 a 5 membros únicos. Desafios expiram em 10 minutos.</p><button class="arenaPrimary" data-arena-queue="guild_war">PROCURAR GUERRA</button></section>';
  if(tab==='ranking')body='<section><h2>Ranking PvP</h2><div id="arenaRanking"><p>Carregando classificação...</p></div></section>';
  if(tab==='rewards')body='<section><h2>Recompensas da Temporada</h2><p>Bronze · Prata · Ouro · Platina · Diamante · Mestre</p><p>As recompensas são vinculadas à divisão final e não compram Rating.</p></section>';
  return head+'<nav class="arenaTabs">'+tabs+'</nav><div class="arenaBody">'+body+'</div>';
 }
 g.ARENA_UI={render,division};
})(typeof window!=='undefined'?window:globalThis);
