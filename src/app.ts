if (process.env.NODE_ENV !== "production") {
    require('dotenv').config();
}
const catchAsync = require('./methods/catchAsync');
import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import { RequestInfo, RequestInit } from "node-fetch";
const fetch = (url: RequestInfo, init?: RequestInit) => import("node-fetch").then(({ default: fetch }) => fetch(url, init));
import cookieParser from "cookie-parser";
import mongoose from 'mongoose';
import { constants } from './constants';
import { isLoggedIn } from './methods/middleware';
import { createSummariesForRepo } from './methods/openai';
import users from './models/user';
import repos from './models/repo';
import files from './models/file';
import { randomStringToHash24Bits } from './methods/helpers';
import { ResponseWithUser } from './types/apiTypes';


export default class Api {
    private port: number;
    private dbUrl: string;
    constructor(port: number, dbUrl: string) {
        this.port = port;
        this.dbUrl = dbUrl;
    }


    userRoutes(): express.Router {
        const userRouter = express.Router();
        userRouter.get('/', (req: Request, res: Response) => {
            res.send('Welcome to the home of Claribase, we are currently working to get up and running. For any questions please contact patrick.123.foster@gmail.com');
        });

        //create a route that takes a file id and returns the contentURL of the file and the summary

        userRouter.get('/file/:fileId', isLoggedIn, catchAsync(async (req: Request, res: Response, next: NextFunction) => {
            console.log('we are here')!
            const { fileId } = req.params;
            console.log(fileId);
            const file = await files.findById(fileId);
            console.log(file)
            if (!file) {
                return res.status(404).send({ message: 'file not found' });
            } else {
                const contentResponse = await fetch(file.contentUrl);
                const content = await contentResponse.text();
                console.log(content);
                return res.status(200).send({ content: content, summary: file.summary });
            }
        }));
        return userRouter;
    }

    authRoutes(): express.Router {
        const authRouter = express.Router();

        if (process.env.NODE_ENV !== "production") {
            authRouter.get('/wipe', async () => {
                await users.deleteMany({});
                await repos.deleteMany({});
                await files.deleteMany({});
                console.log('deleted everything');
            })
        }
        authRouter.get('/isLoggedIn', isLoggedIn, catchAsync(async (req: Request, res: Response, next: NextFunction) => {
            res.status(200).send({ message: 'user authenticated' });
        }));

        authRouter.post('/google', catchAsync(async (req: Request, res: Response, next: NextFunction) => {
            const { idToken, email, profilePicture, name } = req.body;
            const uid = randomStringToHash24Bits(idToken);
            const user = await users.findById(uid);
            if (!user) {
                const newUser = new users({ _id: uid, email: email, name: name, profilePicture: profilePicture })
                await newUser.save();
            }
            const token = jwt.sign({ _id: uid, }, process.env.JWT_PRIVATE_KEY, { expiresIn: "1000d" });
            res.status(200).send({ token: token, message: 'Login successful' });
        }));



        return authRouter;
    }

    githubRoutes(): express.Router {
        const githubRouter = express.Router();
        githubRouter.post('/callback', (req: Request, res: Response) => {
            console.log('we are at the callback funciton')
            //log the current date and time in CST 
            console.log(req.body);
            res.status(200).send({})

        });
        githubRouter.post('/webhook', (req: Request, res: Response) => {
            console.log('we are at the webhook function');
            console.log(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
            console.log(JSON.stringify(req.body, null, 2));
            console.log('END OF THE webhook FUNCTION');
            res.status(200).send({})

        });

        githubRouter.post('/connect', isLoggedIn, catchAsync(async (req: Request, res: ResponseWithUser, next: NextFunction) => {
            const { code } = req.body;
            const params = "?client_id=" + constants.client_id + "&client_secret=" + constants.client_secret + "&code=" + code;

            //takes the code and gets the access token
            const responseForToken = await fetch('https://github.com/login/oauth/access_token' + params, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json'
                },
            })
            const dataForToken = await responseForToken.json();
            const accessToken = dataForToken.access_token;
            if (accessToken) {
                //takes the access token and gets the user id. The return also includes all of the users baseline information
                const responseForUserId = await fetch('https://api.github.com/user', {
                    headers: {
                        'Authorization': `token ${accessToken}`
                    }
                })
                const dataForUserId = await responseForUserId.json();
                if (dataForUserId.login) {
                    console.log('Successfully got the users name with the access token: ' + accessToken);
                    //@ts-ignore
                    const userId = dataForUserId.login;

                    await users.findByIdAndUpdate(res.userId, { githubId: userId, accessToken: accessToken });

                    //takes the user id and gets their repos
                    console.log('asdfsdfsd')
                    const responseRepos = await fetch('https://api.github.com/users/' + userId + "/repos");

                    const dataRepos = await responseRepos.json();
                    const names: string[] = dataRepos.map((repo: any) => repo.name);
                    return res.status(200).send({ names: names });
                }
            }

            res.status(403).send({ message: 'poor authentications' });
        }));

        githubRouter.get('/refreshrepo/:repoName', isLoggedIn, catchAsync(async (req: Request, res: ResponseWithUser, next: NextFunction) => {
            const { repoName } = req.params;
            const user = res.user;
            const files = await createSummariesForRepo(user.repositories.find((repo: any) => repo.name === repoName).id, user.githubId, repoName);
            return res.status(200).send({ files: files });
        }));

        githubRouter.get('/repo/:repoName', isLoggedIn, catchAsync(async (req: Request, res: ResponseWithUser, next: NextFunction) => {
            const { repoName } = req.params;
            const user = res.user;
            var repoAlreadyExists: boolean = false;
            var repoId: string = '';
            for (let repo of user.repositories) {
                if (repo.name === repoName) {
                    repoAlreadyExists = true;
                    repoId = repo.id;
                    break;
                }
            }
            if (!repoAlreadyExists) {
                console.log('first if statement');
                const newRepo = new repos({ name: repoName, userId: res.userId });
                await users.findByIdAndUpdate(res.userId, { $push: { repositories: { name: repoName, id: newRepo.id } } });
                await newRepo.save();
                const files = await createSummariesForRepo(newRepo.id, user.githubId, repoName);
                console.log('we have returned from the createSummariesForRepo function');
                console.log(files);
                return res.status(200).send({ files: files });
                // await newRepo.save();
                // repoId = newRepo.id;
                // await users.findByIdAndUpdate(res.userId, { $push: { repositories: { name: repoName, id: repoId } } });
            } else {
                console.log('second if statement');
                const repoInfo = await repos.findById(repoId);
                return res.status(200).send({ files: repoInfo.files });
            }
        }));


        return githubRouter
    }

    error(): ErrorRequestHandler {
        return (err: Error, req: Request, res: Response, next: NextFunction) => {
            console.log('we are in the error function');
            console.log(err);
            res.status(500).send({ error: err.message });
        }
    }


    start(): void {
        mongoose.set('strictQuery', true);
        mongoose.connect(this.dbUrl, {
            //@ts-ignore
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });

        const db = mongoose.connection;
        db.on("error", console.error.bind(console, "connection error:"));
        db.once("open", () => {
            console.log("✅ We're connected to the database");
        });


        const app = express();
        app.use(bodyParser.json(), bodyParser.urlencoded({ extended: false }))
        app.use(cors());
        app.use(cookieParser());
        app.use(`${constants.baseApiUrl}/user`, this.userRoutes());
        app.use(`${constants.baseApiUrl}/auth`, this.authRoutes());
        app.use(`${constants.baseApiUrl}/github`, this.githubRoutes());
        app.use(this.error());


        let PORT: number | string = process.env.PORT;
        if (PORT == null || PORT == "") {
            PORT = this.port;
        }
        app.listen(PORT, () => {
            return console.log(`✅ We're live: ${PORT}`);
        });
    }

}
