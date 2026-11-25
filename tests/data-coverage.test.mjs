import assert from 'node:assert/strict';
import {test} from 'node:test';
import {meetsCoverage} from '../backend/data-coverage.mjs';

test('coverage counts categorized rows and distinct normalized categories', () => {
  const rows = [
    {region:' East '}, {region:'EAST'}, {region:'West'},
    {region:'Québec'}, {region:'Que\u0301bec'}, {region:' '},
    {region:null}, {region:42}, {}, Object.create({region:'Inherited'})
  ];
  const claim = {categoryField:'region', minRecords:5, minCategories:3};
  assert.equal(meetsCoverage(rows,claim),true);
  assert.equal(meetsCoverage(rows,{...claim,minRecords:6}),false);
  assert.equal(meetsCoverage(rows,{...claim,minCategories:4}),false);
  assert.equal(meetsCoverage(rows,{...claim,categoryField:'missing'}),false);
});
