import { describe, it, expect } from 'vitest';
import { configurationMeta, readConfiguration } from './configuration';
describe('turn configuration', () => {
 it('distinguishes preserve, explicit override and reset',()=>{
  expect(configurationMeta()).toEqual({});
  expect(configurationMeta({model:'model-a',effort:'high'})).toEqual({model:'model-a',effort:'high'});
  expect(configurationMeta({model:null,effort:null})).toEqual({model:null,effort:null});
 });
 it('rejects malformed values before network or image upload',()=>{
  for(const value of [{model:''},{effort:'random'},{permissionMode:'unsafe'},null,[]]) expect(()=>configurationMeta(value as never)).toThrow();
 });
 it('only returns advertised catalog options and handles missing metadata',()=>{
  expect(readConfiguration(null)).toEqual({model:null,effort:null,models:[],efforts:[]});
  expect(readConfiguration({currentModelCode:'a',currentThoughtLevelCode:'high',models:[{code:'a',value:'Model A'},null,{}],thoughtLevels:[{code:'high',value:'High'}]})).toEqual({model:'a',effort:'high',models:[{code:'a',label:'Model A'}],efforts:[{code:'high',label:'High'}]});
 });
});
