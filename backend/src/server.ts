import express from "express";
import * as path from "path";
import uploadRouter from "./routes/upload";
import jobsRouter from "./routes/jobs";

const app = express();
app.use(express.json());

app.use("/api/upload", uploadRouter);
app.use("/api/jobs", jobsRouter);

app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`ESXi Image Builder listening on :${port}`);
});
