const core = require("@actions/core");
const github = require("@actions/github");
const resolve = require('path').resolve;
const fs = require('fs')

let erroredCheck2 = false;

async function run() {
    try {
        const token = core.getInput("repo-token");
        const octokit = github.getOctokit(token);
        let sha
        let isPull = false
        if(typeof github.context.payload.pull_request != 'undefined'){
            isPull = true
            sha = github.context.payload.pull_request.head.sha
        }else{
            sha = github.context.sha
        }

        /* Create two seperate checks in Github */
        const check1 = await octokit.rest.checks.create({
            ...github.context.repo,
            head_sha: sha,
            status: 'in_progress',
            started_at: new Date().toISOString(),
            name: 'Parsing JSON'
        })
        const check2 = await octokit.rest.checks.create({
            ...github.context.repo,
            head_sha: sha,
            status: 'queued',
            started_at: new Date().toISOString(),
            name: 'File checks'
        })
        const annotations1 = [];
        const annotations2 = [];
        
        /* Get changed files */
        let changed
        if(isPull){
            changed = await octokit.rest.pulls.listFiles({
                ...github.context.repo,
                pull_number: github.context.payload.pull_request.number,
            })
        } else {
            changed = getAllFiles('.')
        }
        /* Compile list of items that need to be checked later + parse all JSON */
        const items = []
        let size
        if(isPull)
            size = changed.data.length
        else
            size = changed.length
        for(let i = 0; i < size; i++){
            let file 
            if(isPull)
                file = changed.data[i];
            else
                file = changed[i];
            console.log(file)
            console.log(isPull && file.filename.endsWith('.json') && file.status != 'deleted' || !isPull && file.endsWith('.json'))
            if(isPull && file.filename.endsWith('.json') && file.status != 'deleted' || !isPull && file.endsWith('.json')){
                let string = fs.readFileSync(resolve(file.filename))
                string = string.toString();
                try{
                    JSON.parse(string)
                    if(isPull && file.filename.startsWith('items')){
                        items.push(file.filename)
                    }else if(!isPull && file.startsWith('items')){
                        items.push(file)
                    }
                }catch(err){
                    /* If parsing fails find line of error and set annotation */
                    const num = parseInt(err.message.split(' ')[err.message.split(' ').length - 1]);
                    let line = undefined;
                    if(typeof num == 'number'){
                        line = getlineNumberofChar(string, num)
                    }
                    core.error('Parsing JSON failed for ' + file.filename);
                    let path
                    if(isPull)
                        path = file.filename
                    else
                        path = file
                    console.log(path)
                    annotations1.push({
                        title: 'Parsing JSON failed for ' + file.filename,
                        message: err.message,
                        annotation_level: 'failure',
                        path: path,
                        start_line: line,
                        end_line: line
                    })
                }
            }
        }

        /* Update first check to completed and depeding if we have annotations failure or succes + start second check */
        octokit.rest.checks.update({
            ...github.context.repo, 
            check_run_id: check1.data.id,
            commit_id: sha,
            conclusion: (annotations1.length > 0 ? 'failure' : 'success'),
            status: 'completed',
            output: {
                title: "Parsing JSON results",
                summary: "The results after parsing all of the changed JSON files.",
                annotations: annotations1
            }
        })
        octokit.rest.checks.update({
            ...github.context.repo, 
            check_run_id: check2.data.id,
            commit_id: sha,
            status: 'in_progress',
        })

        /* Start item checks */
        for(const i in items){
            const item = items[i];
            const file = require(resolve(item))
            /* Check if some fields exist, these things will fail the check. */
            if(typeof file.internalname == 'undefined'){
                core.error(item + ' does not have mandatory field internalname.')
                annotations2.push({
                    title: item + ' does not have mandatory field internalname.',
                    message: 'The field internalname is required and this file doesn\'t have it.',
                    annotation_level: 'failure',
                    path: item,
                    start_line: 1,
                    end_line: 1
                })
                erroredCheck2 = true;
            } 
            if(typeof file.displayname == 'undefined'){
                core.error(item + ' does not have mandatory field displayname.')
                annotations2.push({
                    title: item + ' does not have mandatory field displayname.',
                    message: 'The field displayname is required and this file doesn\'t have it.',
                    annotation_level: 'failure',
                    path: item,
                    start_line: 1,
                    end_line: 1
                })
                erroredCheck2 = true;
            }
            if(typeof file.itemid == 'undefined'){
                core.error(item + ' does not have mandatory field itemid.')
                annotations2.push({
                    title: item + ' does not have mandatory field itemid.',
                    message: 'The field itemid is required and this file doesn\'t have it.',
                    annotation_level: 'failure',
                    path: item,
                    start_line: 1,
                    end_line: 1
                })
                erroredCheck2 = true;
            }
            /* Check if lore and nbt tag lore is the same + check that nbt tag doesn't include uuid or timestamp, these things will not cause
            a failure but will simpely give a warning and an anotation, workflow will still succeed. */
            const display = file.nbttag.split('display:{Lore:[')[1].split('],')[0]
            let lines = display.split(/",[0-9]+:"/g)
            lines[0] = lines[0].substring(3)
            lines[lines.length -1] = lines[lines.length -1].substring(0, lines[lines.length -1].length-1)
            same = true;
            for(const l in lines){
                if(lines[l] != file.lore[l]){
                    same = false;
                }
            }
            if(!same){
                core.warning('The lore of the nbt tag and the lore in the array is not the same, please fix this.')
                annotations2.push({
                    title: 'The lore in the nbt tag and lore of ' + item + ' is not the same.',
                    message: 'The lore of the nbt tag and the lore in the array is not the same, please fix this.',
                    annotation_level: 'warning',
                    path: item,
                    start_line: getWordLine(fs.readFileSync(item).toString(), '"nbttag"'),
                    end_line:  getWordLine(fs.readFileSync(item).toString(), '"nbttag"')
                })
            }
            if(file.nbttag.includes("uuid:\"")){
                core.warning('The nbt tag for item ' + item + ' contains a uuid, this is not allowed.')
                annotations2.push({
                    title: 'The nbt tag for item ' + item + ' contains a uuid.',
                    message: 'The nbt tag for item ' + item + ' contains a uuid, this is not allowed.',
                    annotation_level: 'warning',
                    path: item,
                    start_line: getWordLine(fs.readFileSync(item).toString(), '"nbttag"'),
                    end_line:  getWordLine(fs.readFileSync(item).toString(), '"nbttag"')
                })
            }
            if(file.nbttag.includes("timestamp:\"")){
                core.warning('The nbt tag for item ' + item + ' contains a timestamp, this is not allowed.')
                annotations2.push({
                    title: 'The nbt tag for item ' + item + ' contains a timestamp',
                    message: 'The nbt tag for item ' + item + ' contains a timestamp, this is not allowed.',
                    annotation_level: 'warning',
                    path: item,
                    start_line: getWordLine(fs.readFileSync(item).toString(), '"nbttag"'),
                    end_line:  getWordLine(fs.readFileSync(item).toString(), '"nbttag"')
                })
            }
        }

        /* Update final check to be succes if no warnings or errors, neutral if warnings and failure if errors */
        octokit.rest.checks.update({
            ...github.context.repo, 
            check_run_id: check2.data.id,
            commit_id: sha,
            conclusion: (erroredCheck2 ? 'failure' : (annotations2 > 0 ? 'neutral' : 'success')),
            status: 'completed',
            output: {
                title: "File checks conclusions",
                summary: "The results after checking all files for mistakes.",
                annotations: annotations2
            }
        })
        /* Create a comment if any warnings or errors have been detected */
        if(isPull && (annotations1.length > 0 || annotations2.length > 0)) {
            octokit.rest.issues.createComment({
                ...github.context.repo,
                issue_number: github.context.payload.pull_request.number,
                body: `I've detected some problems you might want to take a look at, you can see them as annotations in the files tab.`
            })
        }

        /* Fail action if there were any errors */
        if(annotations1.length > 0 || erroredCheck2){
            core.setFailed('This action has failed, I have left some annotations in the files tab of the pull request.')
        }
    } catch (err) { 
        core.setFailed(err.message);
    }
}

function getlineNumberofChar(data, index) {
    const line = data.split('\n');
    let total_length = 0;
    for (const i in line) {
        total_length += line[i].length + 1;
        if (total_length >= index)
            return parseInt(i) + 1;
    }
}

function getWordLine(input, word){
    const line = input.split('\n');
    for (let i in line) {
        if(line[i].includes(word))
            return parseInt(i) + 1;
    }
    return 1;
}

function getAllFiles(path) {
	const allFiles = fs.readdirSync(path, { withFileTypes: true });
	const files = allFiles.filter(file => file.name.endsWith('json'));
	const dirs = allFiles.filter(file => file.isDirectory());
	const names = [];
	for(const file in files) {
		names.push(`${path}/${files[file].name}`);
	}
	for(const dir of dirs) {
		const components = getAllFiles(`${path}/${dir.name}`);
		for(const value in components) {
			names.push(components[value]);
		}
	}
    for (const i in names)
        names[i] = names[i].replace('./', '');
	return names;
}
  
run()