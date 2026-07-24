// Entrypoint serverless de Vercel: reexporta la app Express de server.mjs. vercel.json
// enruta /api/* aquí; los archivos estáticos de public/ los sirve Vercel directamente.
import { app } from '../server.mjs';

export default app;
