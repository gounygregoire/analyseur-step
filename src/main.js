import { Viewer } from "@xeokit/xeokit-sdk";
import "./error-handler.js";
import "./upload-handler.js";
import "./design-insights.js";
import { initViewer, loadXeokitSDK } from "./xeokit_viewer.js";
import { jsPDF } from "jspdf";

window.Viewer = Viewer;
window.initViewer = initViewer;
window.loadXeokitSDK = loadXeokitSDK;
window.jsPDF = jsPDF;
