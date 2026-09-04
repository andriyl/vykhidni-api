import {GoogleGenerativeAI} from "@google/generative-ai";
import 'dotenv/config';


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export const model = genAI.getGenerativeModel({model: "gemini-2.0-flash-lite"});
