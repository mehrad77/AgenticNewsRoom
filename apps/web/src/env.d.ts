/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    site: import("./lib/site.ts").Site;
  }
}
