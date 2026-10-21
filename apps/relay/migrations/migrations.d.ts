// The types of `migrations.js`, which drizzle-kit writes: each migration's SQL by its folder's name.
declare const bundle: { readonly migrations: Record<string, string> };
export default bundle;
