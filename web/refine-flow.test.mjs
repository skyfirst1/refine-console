import test from 'node:test';
import assert from 'node:assert/strict';
import { REFINE_NODES, renderRefineFlow, renderRefineDetail } from './refine-flow.js';

test('nine Refine stages come from recorded completion, not assumed success', () => {
  const cache = {'independent-refine-result': {content:JSON.stringify({completedStages:REFINE_NODES.map(n=>n.id)})},'independent-refine-summary':{content:JSON.stringify({decision:{decision:'reject',activeSkillMutated:false}})}};
  const html = renderRefineFlow(cache, null, REFINE_NODES.map(n=>'independent-refine-'+n.artifact));
  assert.match(html,/9 \/ 9 阶段已执行/);
  assert.match(html,/未采用新 Skill/); assert.match(html,/当前 Skill 保持不变/);
  for(const n of REFINE_NODES) assert.ok(html.includes(`data-flow-node="refine:${n.id}"`));
  assert.doesNotMatch(html,/ style=|data-generate-summary/);
  assert.doesNotMatch(renderRefineFlow(),/9 \/ 9 阶段已执行|未采用新 Skill/);
});

test('overview puts real before/after scores beside the decision, without treating a higher score as acceptance', () => {
  const cache = {'independent-refine-summary':{content:JSON.stringify({decision:{decision:'reject',currentF1:.571428,candidateF1:.729166,expertGatePassed:false,judgeVerdict:'regressed',activeSkillMutated:false}})}};
  const html = renderRefineFlow(cache);
  for(const text of ['原稿是什么样','规则怎么改','改完值得采用吗','0.5714','0.7292','未采用新 Skill','验收门槛未通过','独立审查判为退化']) assert.ok(html.includes(text),text);
  assert.ok(html.indexOf('refine-result-strip') < html.indexOf('class="refine-story"'));
  assert.doesNotMatch(renderRefineFlow(),/0.5714|0.7292|未采用新 Skill|独立审查判为退化/);
});

test('Refine decision keeps score improvement distinct from promotion', () => {
  const id = 'independent-refine-decision';
  const html = renderRefineDetail('promotion-decision', {[id]:{content:JSON.stringify({decision:'reject',activeSkillMutated:false,expert:{currentScore:.57,candidateScore:.73,gatePassed:false},judge:{verdict:'regressed',reason:'<script>真实历史理由</script>'}})}},[id]);
  for(const text of ['0.5700','0.7300','未晋升','未通过','判为退化','未被修改']) assert.ok(html.includes(text));
  assert.doesNotMatch(html,/<script>/); assert.match(html,/&lt;script&gt;/);
  assert.match(renderRefineDetail('candidate-skill-compilation'),/正文尚未登记/);
  assert.match(renderRefineDetail('candidate-skill-compilation',{},['independent-refine-skill']),/正在读取/);
});

test('each registered stage renders its own content; failures remain visible', () => {
  for(const node of REFINE_NODES) {
    const id = 'independent-refine-'+node.artifact;
    const html = renderRefineDetail(node.id,{[id]:{content:'真实阶段原文'}},[id]);
    assert.match(html,new RegExp(node.title)); assert.ok(html.includes(`data-artifact="${id}"`));
    assert.match(renderRefineDetail(node.id,{[id]:{error:'校验失败'}},[id]),/校验失败/);
  }
});
