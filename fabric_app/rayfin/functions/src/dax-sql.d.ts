// dax-sql ships JavaScript with no types: what the function calls of it.
declare module 'dax-sql' {
  export function createCompiler(model: any, options?: Record<string, any>): any;
}
declare module 'dax-sql/formats/tmsl.js' {
  export function tmslToModel(bim: any): any;
}
declare module 'dax-sql/formats/ossie.js' {
  export function ossieToTmsl(doc: any): any;
}
