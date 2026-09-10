import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "syncthis", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
