import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "components/Explore/helpers/exploreParams";
import factory, { makeResponse } from "tests/factory";
import faker from "tests/helpers/faker";

describe( "getNextPageParamForExplore", ( ) => {
  const page = makeResponse( [factory( "RemoteObservation" )] );
  it( "should return a date + id tiebreaker if order_by is observed_on", ( ) => {
    const params = { order_by: "observed_on" };
    const nextPageParam = getNextPageParamForExplore( page, params );
    expect( nextPageParam.date ).toMatch( /\d{4}-\d{2}-\d{2}/ );
    expect( nextPageParam.id ).toEqual( page.results[0].id );
  } );
  it( "should return a date + id tiebreaker if order_by is created_at", ( ) => {
    const params = { order_by: "created_at" };
    const nextPageParam = getNextPageParamForExplore( page, params );
    expect( nextPageParam.date ).toMatch( /\d{4}-\d{2}-\d{2}/ );
    expect( nextPageParam.id ).toEqual( page.results[0].id );
  } );
  it( "should return an obs id if order_by is blank", ( ) => {
    const params = { };
    expect( getNextPageParamForExplore( page, params ) ).toEqual( page.results[0].id );
  } );
  it( "should return the next page number if order_by is votes", ( ) => {
    const params = { order_by: "votes" };
    expect( getNextPageParamForExplore( page, params ) ).toEqual( page.page + 1 );
  } );
} );

describe( "addPageParamsForExplore", ( ) => {
  it( "should include return_bounds when pageParam is undefined", ( ) => {
    const params = {};
    expect( addPageParamsForExplore( params ).return_bounds ).toEqual( true );
  } );
  it( "should include return_bounds when pageParam is 0", ( ) => {
    const params = { pageParam: 0 };
    expect( addPageParamsForExplore( params ).return_bounds ).toEqual( true );
  } );
  it( "should not include return_bounds when pageParam is 1 ", ( ) => {
    const params = { pageParam: 1 };
    expect( addPageParamsForExplore( params ).return_bounds ).toBeUndefined( );
  } );
  it( "should set d2 and id_below if order_by is observed_on and order is default desc", ( ) => {
    const dateString = faker.date.recent( ).toISOString( );
    const pageParam = { date: dateString, id: 123 };
    const params = { pageParam, order_by: "observed_on" };
    const result = addPageParamsForExplore( params );
    expect( result.d2 ).toEqual( dateString );
    expect( result.id_below ).toEqual( 123 );
  } );
  it( "should set d1 and id_above if order_by is observed_on and order is asc", ( ) => {
    const dateString = faker.date.recent( ).toISOString( );
    const pageParam = { date: dateString, id: 123 };
    const params = { pageParam, order_by: "observed_on", order: "asc" };
    const result = addPageParamsForExplore( params );
    expect( result.d1 ).toEqual( dateString );
    expect( result.id_above ).toEqual( 123 );
  } );
  it( "should set created_d2 and id_below if order_by is created_at, order desc", ( ) => {
    const dateString = faker.date.recent( ).toISOString( );
    const pageParam = { date: dateString, id: 123 };
    const params = { pageParam, order_by: "created_at" };
    const result = addPageParamsForExplore( params );
    expect( result.created_d2 ).toEqual( dateString );
    expect( result.id_below ).toEqual( 123 );
  } );
  it( "should set created_d1 and id_above if order_by is created_at and order is asc", ( ) => {
    const dateString = faker.date.recent( ).toISOString( );
    const pageParam = { date: dateString, id: 123 };
    const params = { pageParam, order_by: "created_at", order: "asc" };
    const result = addPageParamsForExplore( params );
    expect( result.created_d1 ).toEqual( dateString );
    expect( result.id_above ).toEqual( 123 );
  } );
  it( "should set page if order_by is votes", ( ) => {
    const params = { order_by: "votes", pageParam: 1 };
    expect( addPageParamsForExplore( params ).page ).toEqual( params.pageParam );
  } );
  it( "should set id_below if order_by is not specified", ( ) => {
    const params = { pageParam: 123 };
    expect( addPageParamsForExplore( params ).id_below ).toEqual( params.pageParam );
  } );
} );
