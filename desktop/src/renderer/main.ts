import { mountApp } from "./app.js";
import { createCall } from "./call.js";

mountApp(document.getElementById("app")!, { bridge: window.cloneme, createCall });
