// import-in-the-middle ships types as register-hooks.d.ts beside register-hooks.mjs, with no exports
// map to connect them.
declare module "import-in-the-middle/register-hooks.mjs" {
  export * from "import-in-the-middle/register-hooks";
}
