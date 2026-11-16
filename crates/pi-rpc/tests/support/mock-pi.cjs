// Offline protocol fixture. No model, credentials or user session directory.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('1.5.2 (offline test fixture)');process.exit(0); }
let sessionFile = args.includes('--session') ? args[args.indexOf('--session') + 1] : path.join(process.cwd(), `mock-${process.pid}.jsonl`);
let sequence = 0, compact = null, cancelSwitch = false, cancelBranch = false, failBranch = false, ignoreEof = false;
let streamTimer=null, streamText='';
function finishStream(aborted) {
  if(!streamTimer)return;
  clearInterval(streamTimer);streamTimer=null;
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:streamText}],stopReason:aborted?'aborted':'stop'}});
  emit({type:'agent_settled',aborted});
}
function persist(file) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({type:'session',version:3,id:'mock-session',cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
}
persist(sessionFile);
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
function reply(request, data={}) { emit({type:'response',id:request.id,command:request.type,success:true,data}); }
const model = {id:'mock',provider:'offline',input:['text','image'],contextWindow:10000,reasoning:false};
const messages = [{role:'user',content:[{type:'text',text:'original question'}],timestamp:0}];
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const request=JSON.parse(line);
  switch(request.type) {
    case 'get_state': return reply(request,{sessionFile,sessionId:'mock-session',sessionName:path.basename(sessionFile),model,isStreaming:false,isCompacting:!!compact});
    case 'get_messages': return reply(request,{messages});
    case 'get_session_stats': return reply(request,{tokens:{total:123,input:100,output:23,cacheRead:0,cacheWrite:0},cost:0,contextUsage:{tokens:80,contextWindow:10000,percent:0.8}});
    case 'compact':
      compact=request;
      emit({type:'compaction_start',reason:'manual'});
      setTimeout(()=>{if(compact){reply(compact);compact=null;}},2000).unref();
      return;
    case 'abort':
      finishStream(true);
      if(compact){reply(compact);compact=null;emit({type:'compaction_end',reason:'manual',aborted:true,willRetry:false});}
      return reply(request);
    case 'cancel_next_switch': cancelSwitch=true; return reply(request);
    case 'cancel_next_branch': cancelBranch=true; return reply(request);
    case 'fail_next_branch': failBranch=true; return reply(request);
    case 'fork': case 'clone':
      if(cancelBranch){cancelBranch=false;return reply(request,{cancelled:true});}
      sessionFile=path.join(process.cwd(),`branch-${process.pid}-${++sequence}.jsonl`);
      if(failBranch){persist(sessionFile);failBranch=false;emit({type:'response',id:request.id,command:request.type,success:false,error:'simulated failure after replacement'});return;}
      persist(sessionFile); return reply(request,{cancelled:false,text:request.type==='fork'?'selected question':undefined});
    case 'switch_session':
      if(cancelSwitch){cancelSwitch=false;return reply(request,{cancelled:true});}
      sessionFile=request.sessionPath; persist(sessionFile); return reply(request,{cancelled:false});
    case 'new_session': sessionFile=path.join(process.cwd(),`new-${process.pid}-${++sequence}.jsonl`);persist(sessionFile);return reply(request,{cancelled:false});
    case 'get_tree': return reply(request,{tree:[]});
    case 'get_commands': return reply(request,{commands:[]});
    case 'get_available_models': return reply(request,{models:[model]});
    case 'prompt': case 'steer': case 'follow_up':
      reply(request,{message:request.message,images:request.images});
      if(process.env.PI_MOCK_STREAM==='1') {
        finishStream(false);streamText='';
        emit({type:'agent_start'});
        emit({type:'message_start',message:{role:'user',content:[{type:'text',text:request.message},...(request.images||[])]}});
        emit({type:'message_start',message:{role:'assistant',content:[]}});
        const output=Array.from('离线验证：消息已收到，输入、事件流和停止按钮正常工作。'.repeat(20));let at=0;
        streamTimer=setInterval(()=>{if(at===output.length){finishStream(false);return;}const delta=output[at++];streamText+=delta;emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});},200);
      }
      return;
    case 'exit_without_reply': return process.exit(7);
    case 'ignore_eof': ignoreEof=true;setInterval(()=>{},1000);return reply(request);
    case 'stderr_large': process.stderr.write('x'.repeat(128*1024)+'\nsmall log\n');return reply(request);
    case 'emit_dialog': emit({type:'extension_ui_request',id:'dialog-1',method:'confirm',title:'Continue?',options:[]});return reply(request);
    case 'extension_ui_response': return;
    default: return reply(request);
  }
});
input.on('close',()=>{if(!ignoreEof)process.exit(0);});
