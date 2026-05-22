var DEMO_MODE=false;
var clients=[];
var previewPayload=null;
var previewClientKey='';
var lastDiagnosticContext=null;
var monitorTimer=null;
var monitorStartedAt=0;
var monitorBusy=false;
var el={};
['conversationUrl','clientSelect','resolvedClient','previewBtn','executeBtn','statusBar','statusText',
 'output','copyBtn','sAccount','sConversation','sContact','sPhone','sMessage','sReceived','sDetected','sWebhook',
 'summarySection','previewSection','diagnosticPanel','emptyState','demoBanner','demoToggle',
 'dCode','dTitle','dCause','dSuggestion','dUpstream','dRequest','dWorkflow','dNode','dExecution','dFlowMessage',
 'n8nLookupBtn','clearDiagnosticBtn','activityFeed','historyBody','statsRow',
  'statSuccess','statErrors','statPending','statClients','refreshHistory','summaryBadge',
  'summarySection','previewSection','historyPagination'].forEach(function(id){el[id]=document.getElementById(id)});

var HISTORY_PAGE_SIZE=5;
var ACTIVITY_LIMIT=5;
var histPage=1;
var _activityExpanded=false;
var MOCK_CLIENTS=[
  {key:'iainfinity',name:'IA Infinity',webhook_url:'https://n8n.iainfinity.com.br/webhook/chatwoot-reprocess'},
  {key:'techcorp',name:'TechCorp Ltda',webhook_url:'https://n8n.techcorp.com/webhook/chatwoot'},
  {key:'digitalsolutions',name:'Digital Solutions SA',webhook_url:'https://n8n.digitalsolutions.com/webhook/reprocess'},
  {key:'cloudservices',name:'Cloud Services',webhook_url:'https://n8n.cloudservices.io/webhook/chatwoot'},
  {key:'datacenter',name:'DataCenter Brasil',webhook_url:''},
  {key:'omnichannel',name:'OmniChannel Plus',webhook_url:'https://n8n.omnichannel.com.br/webhook/cw'},
];

var MOCK_PREVIEW={
  "webhookUrl":"https://n8n.iainfinity.com.br/webhook/chatwoot-reprocess",
  "success":true,
  "payload":[{
    "body":{
      "id":7544,
      "conversation_id":7544,
      "account_id":12,
      "meta":{"sender":{"name":"JoÃ£o Pedro Silva","phone_number":"+55 (11) 99999-8877","email":"joao.silva@email.com","id":89234}},
      "messages":[{
        "id":145678,"account_id":12,"conversation_id":7544,
        "content":"OlÃ¡, gostaria de contratar o plano empresarial. Pode me passar mais informaÃ§Ãµes sobre os valores e benefÃ­cios?",
        "message_type":"incoming","source_id":"whatsapp:+5511999998877",
        "created_at":1716323000,"sender":{"name":"JoÃ£o Pedro Silva","phone_number":"+55 (11) 99999-8877","id":89234}
      }],
      "contact":{"id":89234,"name":"JoÃ£o Pedro Silva","phone_number":"+55 (11) 99999-8877","email":"joao.silva@email.com"},
      "inbox_id":5,"status":"open","created_at":1716322800
    }
  }]
};

var MOCK_HISTORY=[
  {id:'RP-2405',conv:'7544',client:'IA Infinity',status:'success',date:'21/05 14:23',duration:'1.2s'},
  {id:'RP-2404',conv:'7512',client:'TechCorp Ltda',status:'error',date:'21/05 14:10',duration:'3.4s'},
  {id:'RP-2403',conv:'7498',client:'IA Infinity',status:'success',date:'21/05 13:55',duration:'0.9s'},
  {id:'RP-2402',conv:'7481',client:'Digital Solutions SA',status:'success',date:'21/05 13:30',duration:'1.1s'},
  {id:'RP-2401',conv:'7455',client:'OmniChannel Plus',status:'warning',date:'21/05 12:48',duration:'2.7s'},
  {id:'RP-2400',conv:'7432',client:'IA Infinity',status:'success',date:'21/05 12:15',duration:'0.8s'},
  {id:'RP-2399',conv:'7420',client:'Cloud Services',status:'success',date:'21/05 11:52',duration:'1.4s'},
  {id:'RP-2398',conv:'7408',client:'TechCorp Ltda',status:'error',date:'21/05 11:30',duration:'4.1s'},
  {id:'RP-2397',conv:'7395',client:'IA Infinity',status:'success',date:'21/05 11:05',duration:'1.0s'},
  {id:'RP-2396',conv:'7382',client:'Digital Solutions SA',status:'success',date:'21/05 10:40',duration:'1.3s'},
];

var MOCK_ACTIVITY=[
  {type:'success',title:'Conversa #7544 reprocessada',desc:'Payload enviado para n8n.iainfinity.com.br',time:'14:23'},
  {type:'error',title:'Falha na conversa #7512',desc:'Webhook retornou HTTP 502 â€” Bad Gateway',time:'14:10'},
  {type:'success',title:'Conversa #7498 reprocessada',desc:'Payload enviado para n8n.iainfinity.com.br',time:'13:55'},
  {type:'success',title:'Conversa #7481 reprocessada',desc:'Payload enviado para digitalsolutions.com',time:'13:30'},
  {type:'warning',title:'Conversa #7455 processada com aviso',desc:'Contato pausado no Supabase â€” fluxo ignorado',time:'12:48'},
  {type:'success',title:'Conversa #7432 reprocessada',desc:'Payload enviado para n8n.iainfinity.com.br',time:'12:15'},
  {type:'info',title:'Cliente OmniChannel Plus adicionado',desc:'Webhook: n8n.omnichannel.com.br',time:'11:58'},
  {type:'success',title:'Conversa #7420 reprocessada',desc:'Payload enviado para cloudservices.io',time:'11:52'},
  {type:'error',title:'Falha na conversa #7408',desc:'Conversa nÃ£o encontrada na API do Chatwoot',time:'11:30'},
  {type:'success',title:'Conversa #7395 reprocessada',desc:'Payload enviado para n8n.iainfinity.com.br',time:'11:05'},
];

var MOCK_JSON_OUTPUT=JSON.stringify(MOCK_PREVIEW,null,2);
function reStagger(container){
  if(!container)return;
  var children=container.children;
  for(var i=0;i<children.length;i++){
    var el=children[i];
    el.style.animation='none';
    el.offsetHeight;
    el.style.animation='';
  }
}
function setStatus(msg,err){
  el.statusText.textContent=msg;
  el.statusBar.style.animation='none';
  el.statusBar.classList.remove('is-visible','is-error');
  void el.statusBar.offsetHeight;
  if(err)el.statusBar.classList.add('is-error');
  else if(msg!=='Carregando clientes...')el.statusBar.classList.add('is-visible');
}

function stopMonitor(){
  if(monitorTimer){clearInterval(monitorTimer);monitorTimer=null}
  monitorBusy=false;monitorStartedAt=0;
}

function resetDiagnostic(){
  el.diagnosticPanel.classList.remove('is-visible');
  lastDiagnosticContext=null;
  el.n8nLookupBtn.disabled=true;
  stopMonitor();
}

function resetPreviewState(){
  previewPayload=null;previewClientKey='';
  el.executeBtn.disabled=true;
  stopMonitor();resetDiagnostic();
}

function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}

function showCards(hasData){
  if(!DEMO_MODE){
    el.summarySection.style.display=hasData?'block':'none';
    el.previewSection.style.display=hasData?'block':'none';
  }
}
function staggerReveal(){
  var cards=document.querySelectorAll('#statsRow>.stat-card');
  cards.forEach(function(el,i){el.style.animationDelay=(.06*i)+'s';el.classList.add('anim-card-stats')});
  var mainCards=document.querySelectorAll('.main-col>.card');
  mainCards.forEach(function(el,i){el.style.animationDelay=(.10+.08*i)+'s';el.classList.add('anim-card')});
  var sideCards=document.querySelectorAll('.side-col>.card');
  sideCards.forEach(function(el,i){el.style.animationDelay=(.15+.1*i)+'s';el.classList.add('anim-side')});
}
function animateCountUp(el, target, suffix){
  if(!el)return;
  var start=0;
  var raw=String(target).replace(/[^0-9]/g,'');
  var num=parseInt(raw,10)||0;
  var duration=800;
  var startTime=performance.now();
  function tick(now){
    var p=Math.min((now-startTime)/duration,1);
    var eased=1-Math.pow(1-p,3);
    var current=Math.round(eased*num);
    el.textContent=current.toLocaleString('pt-BR')+(suffix||'');
    if(p<1)requestAnimationFrame(tick);
    else{el.textContent=target;el.classList.add('counted');}
  }
  requestAnimationFrame(tick);
}

function animateStatCards(){
  animateCountUp(el.statSuccess,'1.234');
  animateCountUp(el.statErrors,'47');
  animateCountUp(el.statPending,'8');
  animateCountUp(el.statClients,'6');
  document.querySelectorAll('.stat-bar-fill').forEach(function(bar){
    var w=bar.getAttribute('style')||'';
    var m=w.match(/width:\s*([\d.]+)%/);
    if(m){
      bar.style.width='0%';
      setTimeout(function(){bar.style.transition='width .8s var(--ease-out)';bar.style.width=m[1]+'%';},200);
    }
  });
}
function renderMockData(){
  el.clientSelect.innerHTML='<option value="">Detectar automaticamente</option>';
  MOCK_CLIENTS.forEach(function(c){
    var o=document.createElement('option');
    o.value=c.key;o.textContent=c.name+(c.key?' ('+c.key+')':'');
    el.clientSelect.appendChild(o);
  });
  el.statSuccess.textContent='1.234';
  el.statErrors.textContent='47';
  el.statPending.textContent='8';
  el.statClients.textContent='6';
  setStatus('Pronto. Link prÃ©-preenchido com dados de demonstraÃ§Ã£o.');
  previewPayload=MOCK_PREVIEW;
  previewClientKey='iainfinity';

  histPage=1;_activityExpanded=false;
  renderHistory();
  renderActivity();
  renderSummary();
  el.output.textContent=MOCK_JSON_OUTPUT;
  el.executeBtn.disabled=false;pulseExecuteBtn();
}

function renderHistory(){
  if(!el.historyBody)return;
  var totalPages=Math.ceil(MOCK_HISTORY.length/HISTORY_PAGE_SIZE);
  if(histPage<1)histPage=1;
  if(histPage>totalPages)histPage=totalPages;
  var start=(histPage-1)*HISTORY_PAGE_SIZE;
  var end=Math.min(start+HISTORY_PAGE_SIZE,MOCK_HISTORY.length);
  var pageItems=MOCK_HISTORY.slice(start,end);
  el.historyBody.innerHTML='';
  el.historyBody.style.animation='none';void el.historyBody.offsetHeight;el.historyBody.style.animation='';
  pageItems.forEach(function(h){
    var tr=document.createElement('tr');
    var statusClass=h.status==='success'?'success':h.status==='error'?'error':'warning';
    var statusLabel=h.status==='success'?'Sucesso':h.status==='error'?'Erro':'Aviso';
    var dotColor=h.status==='success'?'var(--success)':h.status==='error'?'var(--error)':'var(--warning)';
    tr.innerHTML=
      '<td class="mono" style="color:var(--muted)">'+h.id+'</td>'+
      '<td class="mono">'+h.conv+'</td>'+
      '<td><span class="client-tag">'+h.client+'</span></td>'+
      '<td><span class="status-pill '+statusClass+'"><span style="width:5px;height:5px;border-radius:50%;background:'+dotColor+';display:inline-block"></span>'+statusLabel+'</span></td>'+
      '<td style="color:var(--muted);font-size:.82rem">'+h.date+'</td>'+
      '<td style="font-family:var(--font-mono);font-size:.78rem;color:var(--muted)">'+h.duration+'</td>';
    el.historyBody.appendChild(tr);
  });
  renderPagination(totalPages);
}

function renderPagination(totalPages){
  if(!el.historyPagination)return;
  if(totalPages<=1){el.historyPagination.innerHTML='';return}
  var html='';
  html+='<button class="page-prev" onclick="goHistPage('+(histPage-1)+')" '+(histPage<=1?'disabled':'')+'><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3L4 6l3 3"/></svg></button>';
  for(var i=1;i<=totalPages;i++){
    html+='<button class="'+(i===histPage?'active':'')+'" onclick="goHistPage('+i+')">'+i+'</button>';
  }
  html+='<button class="page-next" onclick="goHistPage('+(histPage+1)+')" '+(histPage>=totalPages?'disabled':'')+'><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 3l3 3-3 3"/></svg></button>';
  el.historyPagination.innerHTML=html;
}

function goHistPage(p){histPage=p;renderHistory()}

function renderActivity(){
  if(!el.activityFeed)return;
  el.activityFeed.innerHTML='';
  el.activityFeed.style.animation='none';void el.activityFeed.offsetHeight;el.activityFeed.style.animation='';
  var items=_activityExpanded?MOCK_ACTIVITY:MOCK_ACTIVITY.slice(0,ACTIVITY_LIMIT);
  items.forEach(function(a){
    var div=document.createElement('div');
    div.className='activity-item';
    var dotClass=a.type==='success'?'success':a.type==='error'?'error':a.type==='warning'?'warning':'info';
    div.innerHTML=
      '<span class="dot '+dotClass+'"></span>'+
      '<div class="content"><div class="title">'+a.title+'</div><div class="desc">'+a.desc+'</div></div>'+
      '<span class="time">'+a.time+'</span>';
    el.activityFeed.appendChild(div);
  });
  if(MOCK_ACTIVITY.length>ACTIVITY_LIMIT){
    var wrap=document.createElement('div');
    wrap.className='show-more-wrap';
    wrap.innerHTML='<button class="show-more-btn'+(MOCK_ACTIVITY.length>ACTIVITY_LIMIT&&_activityExpanded?' expanded':'')+'" onclick="toggleActivity()">'+
      (_activityExpanded?'Mostrar menos <span class="arrow">ï¿½-ï¿½</span>':'Ver mais '+MOCK_ACTIVITY.length+' eventos <span class="arrow">ï¿½-ï¿½</span>')+
      '</button>';
    el.activityFeed.appendChild(wrap);
  }
}

function toggleActivity(){
  _activityExpanded=!_activityExpanded;
  renderActivity();
}

function renderSummary(){
  if(!el.sAccount)return;
  el.sAccount.textContent='12';
  el.sConversation.textContent='7544';
  el.sContact.textContent='JoÃ£o Pedro Silva';
  el.sPhone.textContent='+55 (11) 99999-8877';
  el.sMessage.textContent='"OlÃ¡, gostaria de contratar o plano empresarial. Pode me passar mais informaÃ§Ãµes sobre os valores e benefÃ­cios?"';
  el.sReceived.textContent='21/05/2026 Ã s 14:23';
  el.sDetected.textContent='IA Infinity (iainfinity)';
  el.sWebhook.textContent='https://n8n.iainfinity.com.br/webhook/chatwoot-reprocess';
  if(el.summaryBadge)el.summaryBadge.textContent='#7544';
}
var isDemo=false;
function toggleDemo(){return;}
if(el.demoBanner){el.demoBanner.style.display='none';}
if(el.demoToggle){el.demoToggle.style.display='none';}
async function readJsonSafe(response){
  var raw=await response.text();
  try{return raw?JSON.parse(raw):{}}
  catch(e){return{success:false,error:'non_json_response',message:raw||'Resposta nao JSON.'}}
}

async function loadClients(){
  try{
    var resp=await fetch('/api/reprocess/clients');
    var data=await resp.json();
    if(!resp.ok||!data||!data.success)throw new Error(data&&data.message?data.message:'Falha ao carregar clientes.');
    clients=Array.isArray(data.clients)?data.clients:[];
    el.clientSelect.innerHTML='<option value="">Detectar automaticamente</option>';
    clients.forEach(function(c){
      var o=document.createElement('option');
      o.value=c.key;o.textContent=c.name+(c.key?' ('+c.key+')':'');
      el.clientSelect.appendChild(o);
    });
    setStatus('Pronto. Cole o link da conversa.');
  }catch(e){setStatus('Erro ao carregar clientes: '+e.message,true);el.previewBtn.disabled=true}
}

async function generatePreview(){
  var url=el.conversationUrl.value.trim();
  var sel=el.clientSelect.value.trim();
  if(!url){setStatus('Informe o link da conversa.',true);return}
  resetPreviewState();
  el.previewBtn.disabled=true;
  setStatus('Gerando preview no servidor...');
  try{
    var resp=await fetch('/api/reprocess/preview',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({conversationUrl:url,client:sel||undefined,messageCount:1})
    });
    var data=await readJsonSafe(resp);
    el.output.textContent=JSON.stringify(data,null,2);
    if(!resp.ok||!Array.isArray(data)||!data.length){
      if(data&&typeof data==='object'&&!Array.isArray(data))fillDiagnostic(data);
      throw new Error(data&&data.message?data.message:'Falha ao gerar preview.');
    }
    previewPayload=data;
    previewClientKey=sel;
    if(!previewClientKey){
      var pwu=String(data[0]&&data[0].webhookUrl||'').trim().toLowerCase();
      var matched=clients.find(function(c){var wu=String(c.webhook_url||'').trim().toLowerCase();return wu&&pwu&&wu===pwu});
      previewClientKey=matched?matched.key:'';
    }
    var meta=clients.find(function(c){return c.key===previewClientKey});
    el.resolvedClient.value=meta?meta.name+' ('+meta.key+')':previewClientKey||'-';
    fillSummary(data);
    resetDiagnostic();
    el.executeBtn.disabled=!previewPayload||!previewClientKey;
    showCards(true);
    setStatus('Preview gerado. Revise e clique em Reprocessar.');
  }catch(e){setStatus(e.message,true);showCards(false)}
  finally{el.previewBtn.disabled=false}
}

function fillSummary(data){
  var item=Array.isArray(data)?data[0]:null;
  var body=item&&item.body?item.body:{};
  var sender=(body.meta&&body.meta.sender)||(body.messages&&body.messages[0]&&body.messages[0].sender)||{};
  var lastMsg=(body.messages&&body.messages[0]&&body.messages[0].content)||'-';
  var convId=body.id||'-';
  el.sAccount.textContent=(body.messages&&body.messages[0]&&body.messages[0].account_id)??'-';
  el.sConversation.textContent=convId;
  el.sContact.textContent=sender.name||'-';
  el.sPhone.textContent=sender.phone_number||'-';
  el.sMessage.textContent=lastMsg;
  el.sReceived.textContent='-';
  el.sDetected.textContent=previewClientKey||'-';
  el.sWebhook.textContent=item&&item.webhookUrl||'-';
  if(el.summaryBadge)el.summaryBadge.textContent=convId!=='-'?'#'+convId:'';
  showCards(true);
}

async function executeReprocess(){
  if(!previewPayload||!previewClientKey){setStatus('Gere o preview primeiro.',true);return}
  el.executeBtn.disabled=true;
  resetDiagnostic();
  setStatus('Enviando payload para o webhook...');
  try{
    var resp=await fetch('/api/reprocess/execute',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client:previewClientKey,payload:previewPayload})
    });
    var data=await readJsonSafe(resp);
    el.output.textContent=JSON.stringify(data,null,2);
    if(!resp.ok||!data||!data.success){
      if(data&&typeof data==='object')fillDiagnostic(data);
      await fetchLatestN8nError({attempts:4,delayMs:1200,silent:true});
      setStatus(data&&data.message?data.message:'Falha ao executar.',true);
      return;
    }
    lastDiagnosticContext={
      requestId:String(data.request_id||'').trim(),
      client:String(previewClientKey||'').trim(),
      conversationId:getConvId()
    };
    el.n8nLookupBtn.disabled=false;
    startPostExecuteMonitor();
    if(data.pause_status)fillFlowStatus(data.pause_status);
    if(data.skipped&&data.status==='paused'){
      setStatus(data.message||'Contato pausado.',true);return;
    }
    var se=await fetchLatestN8nStatus({attempts:3,delayMs:1000,silent:true});
    var ee=await fetchLatestN8nError({attempts:4,delayMs:1200,silent:true});
    if(ee)setStatus('Enviado, mas o fluxo retornou erro: '+(ee.title||ee.category)+'.',true);
    else if(se)setStatus('Enviado, fluxo retornou status: '+(se.title||se.category)+'.',true);
    else setStatus(data.message||'Reprocessamento enviado com sucesso.');
  }catch(e){setStatus(e.message,true)}
  finally{el.executeBtn.disabled=false;pulseExecuteBtn();}
}

function getConvId(){
  var item=Array.isArray(previewPayload)?previewPayload[0]:null;
  var body=item&&item.body?item.body:{};
  return String(body.conversation_id||body.id||'').trim();
}

function startPostExecuteMonitor(){
  stopMonitor();
  if(!lastDiagnosticContext)return;
  monitorStartedAt=Date.now();
  monitorTimer=setInterval(async function(){
    if(monitorBusy||Date.now()-monitorStartedAt>180000){if(Date.now()-monitorStartedAt>180000)stopMonitor();return}
    monitorBusy=true;
    try{
      var ee=await fetchLatestN8nError({attempts:1,delayMs:200,silent:true});
      if(ee){el.diagnosticPanel.classList.add('is-visible');setStatus('Erro no fluxo: '+(ee.title||ee.category)+'.',true);stopMonitor();return}
      var se=await fetchLatestN8nStatus({attempts:1,delayMs:200,silent:true});
      if(se){el.diagnosticPanel.classList.add('is-visible');setStatus('Status do fluxo: '+(se.title||se.category)+'.',true);}
    }finally{monitorBusy=false}
  },8000);
}

async function fetchLatestN8nError(opts){
  opts=opts||{};var attempts=opts.attempts||1,delay=opts.delayMs||1000,silent=opts.silent||false;
  if(!lastDiagnosticContext){if(!silent)setStatus('Sem contexto de erro.',true);return null}
  el.n8nLookupBtn.disabled=true;
  try{
    for(var a=1;a<=attempts;a++){
      var p=new URLSearchParams();
      if(lastDiagnosticContext.requestId)p.set('request_id',lastDiagnosticContext.requestId);
      if(lastDiagnosticContext.client)p.set('client',lastDiagnosticContext.client);
      if(lastDiagnosticContext.conversationId)p.set('conversation_id',lastDiagnosticContext.conversationId);
      var resp=await fetch('/api/reprocess/n8n/errors/latest?'+p.toString());
      var data=await readJsonSafe(resp);
      if(resp.ok&&data&&data.success&&data.found&&data.event){
        fillN8nDiagnostic(data.event);
        el.dRequest.textContent=(data.event&&data.event.request_id)||el.dRequest.textContent;
        if(!silent)setStatus('DiagnÃ³stico atualizado com erro real do n8n.',true);
        return data.event;
      }
      if(a<attempts)await wait(delay);
    }
    if(!silent)setStatus('Nenhum erro n8n encontrado.',true);
    return null;
  }finally{el.n8nLookupBtn.disabled=!lastDiagnosticContext}
}

async function fetchLatestN8nStatus(opts){
  opts=opts||{};var attempts=opts.attempts||1,delay=opts.delayMs||1000,silent=opts.silent||false;
  if(!lastDiagnosticContext){if(!silent)setStatus('Sem contexto.',true);return null}
  el.n8nLookupBtn.disabled=true;
  try{
    for(var a=1;a<=attempts;a++){
      var p=new URLSearchParams();
      if(lastDiagnosticContext.requestId)p.set('request_id',lastDiagnosticContext.requestId);
      if(lastDiagnosticContext.client)p.set('client',lastDiagnosticContext.client);
      if(lastDiagnosticContext.conversationId)p.set('conversation_id',lastDiagnosticContext.conversationId);
      var resp=await fetch('/api/reprocess/n8n/status/latest?'+p.toString());
      var data=await readJsonSafe(resp);
      if(resp.ok&&data&&data.success&&data.found&&data.event){
        fillFlowStatus(data.event);if(!silent)setStatus('Status do n8n encontrado.',true);
        return data.event;
      }
      if(a<attempts)await wait(delay);
    }
    if(!silent)setStatus('Nenhum status encontrado.',true);
    return null;
  }finally{el.n8nLookupBtn.disabled=!lastDiagnosticContext}
}

function fillN8nDiagnostic(event){
  if(!event||typeof event!=='object')return;
  el.diagnosticPanel.classList.add('is-visible');
  el.dWorkflow.textContent=event.workflow_name||'-';
  el.dNode.textContent=event.failed_node||'-';
  el.dExecution.textContent=event.execution_id||'-';
  el.dFlowMessage.textContent=event.error_description||event.error_message||(event.upstream_messages&&event.upstream_messages[0])||'-';
  el.dUpstream.textContent=(event.upstream_messages&&event.upstream_messages[0])||event.error_message||el.dUpstream.textContent||'-';
  if(event.category){
    var ct=String(el.dCode.textContent||'');
    el.dCode.textContent=ct==='-'||ct===''?event.category:ct+' | '+event.category;
  }
  if(event.title)el.dTitle.textContent=event.title;
  if(event.likely_cause)el.dCause.textContent=event.likely_cause;
  if(event.suggestion)el.dSuggestion.textContent=event.suggestion;
}

function fillDiagnostic(err){
  var d=err&&err.details?err.details:{};
  el.diagnosticPanel.classList.add('is-visible');
  el.dCode.textContent=err.error||'-';
  el.dTitle.textContent=d.title||'-';
  el.dCause.textContent=d.likely_cause||err.message||'-';
  el.dSuggestion.textContent=d.suggestion||'-';
  el.dUpstream.textContent=d.upstream_message||d.error_cause||'-';
  el.dRequest.textContent=d.request_id||err.request_id||'-';
  setDiagContext(err);
  fillN8nDiagnostic(d.n8n_event||null);
}

function fillFlowStatus(event){
  if(!event||typeof event!=='object')return;
  el.diagnosticPanel.classList.add('is-visible');
  el.dCode.textContent=event.category||'flow_status';
  el.dTitle.textContent=event.title||'Status do fluxo n8n';
  el.dCause.textContent=event.likely_cause||'-';
  el.dSuggestion.textContent=event.suggestion||'-';
  el.dUpstream.textContent=(event.upstream_messages&&event.upstream_messages[0])||'-';
  el.dRequest.textContent=event.request_id||el.dRequest.textContent||'-';
  el.dWorkflow.textContent=event.workflow_name||'-';
  el.dNode.textContent=event.failed_node||'-';
  el.dExecution.textContent=event.execution_id||'-';
  el.dFlowMessage.textContent=event.likely_cause||'-';
}

function setDiagContext(err){
  var d=err&&err.details?err.details:{};
  var rid=String(d.request_id||err.request_id||'').trim();
  var cl=String(d.client||previewClientKey||'').trim();
  var cid=getConvId();
  if(!rid&&!cl&&!cid){lastDiagnosticContext=null;el.n8nLookupBtn.disabled=true;return}
  lastDiagnosticContext={requestId:rid,client:cl,conversationId:cid};
  el.n8nLookupBtn.disabled=false;
}
el.copyBtn.addEventListener('click',async function(){
  var text=el.output.textContent;
  try{
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent='Copiado!';
    setTimeout(function(){el.copyBtn.textContent='Copiar JSON';},2000);
  }catch(e){el.copyBtn.textContent='Erro';setTimeout(function(){el.copyBtn.textContent='Copiar JSON';},2000)}
});

el.conversationUrl.addEventListener('input',resetPreviewState);
el.clientSelect.addEventListener('change',resetPreviewState);
el.previewBtn.addEventListener('click',generatePreview);
el.executeBtn.addEventListener('click',executeReprocess);
el.clearDiagnosticBtn.addEventListener('click',resetDiagnostic);
el.refreshHistory.addEventListener('click',function(){return;});

el.n8nLookupBtn.addEventListener('click',function(){
  fetchLatestN8nStatus({attempts:1,delayMs:200,silent:false})
    .then(function(se){if(!se)return fetchLatestN8nError({attempts:1,delayMs:200,silent:false})});
});
var _pulseTimer=null;
function pulseExecuteBtn(){
  if(_pulseTimer)clearTimeout(_pulseTimer);
  el.executeBtn.classList.remove('pulse-cta');
  if(!el.executeBtn.disabled){
    _pulseTimer=setTimeout(function(){el.executeBtn.classList.add('pulse-cta');},100);
    setTimeout(function(){el.executeBtn.classList.remove('pulse-cta');},3500);
  }
}
(function initRealMode(){
  isDemo=false;
  if(el.demoBanner){el.demoBanner.style.display='none';}
  if(el.conversationUrl){el.conversationUrl.value='';}
  if(el.resolvedClient){el.resolvedClient.value='-';}
  el.statSuccess.textContent='--';
  el.statErrors.textContent='--';
  el.statPending.textContent='--';
  el.statClients.textContent='--';
  var statSubs=document.querySelectorAll('.stats-row .stat-sub');
  statSubs.forEach(function(node){node.textContent='sem dados';});
  var statBars=document.querySelectorAll('.stats-row .stat-bar-fill');
  statBars.forEach(function(node){node.style.width='0%';});
  el.output.textContent='{}';
  if(el.activityFeed)el.activityFeed.innerHTML='';
  if(el.historyBody)el.historyBody.innerHTML='';
  showCards(false);
  resetPreviewState();
  loadClients();
  if(typeof staggerReveal==='function')staggerReveal();
  if(typeof animateStatCards==='function')setTimeout(animateStatCards,100);
})();

