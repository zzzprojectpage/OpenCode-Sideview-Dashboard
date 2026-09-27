import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/metrics.mjs';

test('completed request shows context, generation speed and cache hit ratio', () => {
  const messages = [{id:'a', type:'assistant', model:{providerID:'openai',id:'test'},
    time:{created:1000,streamed:2000,completed:4000}, content:[],
    tokens:{input:100,output:40,reasoning:10,cache:{read:300,write:100}}}];
  const result = summarize(messages, [{providerID:'openai',id:'test',limit:{context:1000}}], []);
  assert.equal(result.contextTokens, 550);
  assert.equal(result.contextPercent, 55);
  assert.equal(result.tokensPerSecond, 25);
  assert.equal(result.cachePercent, 60);
});

test('MCP usage includes observed nested Code Mode calls, not code text guesses',()=>{
  const result=summarize([{type:'assistant',content:[{type:'tool',name:'execute',state:{metadata:{toolCalls:[
    {tool:'context7.query-docs',status:'completed'},
    {tool:'context7.resolve-library-id',status:'error'},
  ]}}}]}],[],[{name:'context7',status:{type:'connected'}}]);
  assert.equal(result.mcps[0].calls,2);
});

test('missing measurements stay unavailable; session model share is not cap attribution', () => {
  assert.equal(summarize([]).cachePercent, null);
  assert.equal(summarize([]).tokensPerSecond, null);
  const messages = [
    {id:'1',type:'assistant',model:{providerID:'go',id:'one'},time:{},tokens:{input:100,output:0,reasoning:0,cache:{read:0,write:0}},content:[{type:'tool',name:'context7_query-docs',state:{status:'completed'}}]},
    {id:'2',type:'assistant',model:{providerID:'openai',id:'two'},time:{},tokens:{input:300,output:0,reasoning:0,cache:{read:0,write:0}},content:[]},
  ];
  const result = summarize(messages, [], [{name:'context7',status:'connected'}]);
  assert.deepEqual(result.models.map(m => [m.id,m.percent]), [['two',75],['one',25]]);
  assert.equal(result.mcps[0].calls, 1);
  assert.equal(result.tokensPerSecond, null);
});
