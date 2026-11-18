// /api/index — legacy entry kept so old links keep working.
//
// Every public route has its own file now (api/status.mjs, api/v1/models.mjs,
// ...) because a rewrite's query string is not reliably handed to the
// function. See api/_handler.mjs.

export { default, route } from "./_handler.mjs"
