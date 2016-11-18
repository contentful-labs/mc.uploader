#! /usr/bin/env node
var package = require('./package');
var cmd = require('commander');
var colour = require('colour');
var fs = require('fs');
var p = require('path');
var omit = require('lodash/omit');
var merge = require('lodash/merge');
var get = require('lodash/get');
var mapValues = require('lodash/mapValues');
var fm = require('gray-matter');
var Promise = require('bluebird');
var fsp = Promise.promisifyAll(fs);
var request = require('request-promise');

cmd
    .version('0.0.1')
    .option('-C --config [config]', 'Your settings file (.json), will override any other settings you pass in')
    .option('-t, --token <token>', 'Your contentful api token')
    .option('-l, --lang [lang]', 'The language setting for this content, defaults to en-US', 'en-US')
    .option('-m, --mapper [mapper]', 'You can pass in a mapper file (.js) which has to export one function which can be used to map over the imported data')
    .option('-c, --content-type <content-type>', 'Id for the contentful content type. You need this so that contentful knows which content type to use for these entries')
    .option('-s --space-id <space-id>', 'Id of the contentful space that you want to upload the entries to.')
    .option('-p, --publish', 'Whether or not to publish your uploaded entries immediately', false)
    .usage('-t <token> -s <space-id> -c <content-type> <glob>')
    .parse(process.argv);

if (cmd.config) {
    // if there's a config file we merge all the options
    cmd = merge(cmd, JSON.parse(fs.readFileSync(cmd.config, 'utf8')));
}

var mapper = function (val) {
    return val
};
if (cmd.mapper) {
    mapper = require(p.resolve(process.cwd(), cmd.mapper));
}

var throwError = function (msg, obj) {
    var errorMsg = 'Error: ' + msg;
    if (obj) {
        errorMsg += '\n ' + obj
    }
    console.log(errorMsg.red);
    process.exit(1);
};

var throwApiError = function (error) {
    var type = get(error, 'sys.id');
    var msg = 'Contentful Api Error: ';
    msg += JSON.stringify(error);
    console.log(msg.red);
    process.exit(1);
};

var showProgress = function (msg) {
    console.log('>> Progress: '.blue + msg.blue);
}

var showSuccess = function (msg) {
    console.log('>> Success: '.green + msg.green);
};

var contentfulApi = 'https://api.contentful.com/' + 'spaces/' + cmd.spaceId;
var isError = false;

if (!cmd.token) {
    isError = true;
    throwError('Api token is required');
}

if (!cmd.spaceId) {
    isError = true;
    throwError('A contentful space id is required');
}

if (!cmd.contentType) {
    isError = true;
    throwError('A contentful content type id is required');
}

if (cmd.args.length < 1) {
    isError = true;
    throwError('You need to pass a file or a folder name');
}

if (isError) {
    console.log(
        "\nYou didn't enter all required options, please use as specified:\n".red +
        ">>  ".red +
        "cfupload -t <token> -s <space-id> -c <content-type> <glob>\n".yellow
    );
}

var validateFile = function (file) {
    // check if all required fields are contained in the fields object
    typeSpec.fields.filter(function (field) {
        return field.required == true;
    }).forEach(function (field) {
        // if a field is required but isn't contained by the file
        // we throw
        if (!file.content.fields[field.id]) {
            throwError('validation against content type failed - missing field "' + field.id + '"', JSON.stringify({file: file.path}));
        }
    });

    var typeSpecFields = typeSpec.fields.map(function (field) {
        return field.id;
    });

    // check if all fields are contained in the type spec
    Object.keys(file.content.fields).forEach(function (fieldName) {
        if (typeSpecFields.indexOf(fieldName) < 0) {
            throwError('validation against content type failed - invalid field "' + fieldName + '"', JSON.stringify({file: file.path}));
        }
    });
};

var mapFile = function (file) {
    var data = file.content.data;
    data.body = file.content.content;

    file.content.fields = mapValues(data, function (value, key) {
        var obj = {};
        obj[cmd.lang] = value
        return obj;
    });

    return mapper(file);
};

var contentTypeEndpoint = contentfulApi + '/content_types/' + cmd.contentType + '?access_token=' + cmd.token;
var path = cmd.args;
var toString = function (file) {
    return file.toString();
};

console.log('\nchecking authorisation and if content type exists'.blue +
    '\n>> url: ' + contentTypeEndpoint.underline);

var typeSpec;
var requestsPerSecond;
var requestCount = 0;
var rateLimitThrottle = function () {
    // We can't have more request than `requestsPerSecond`
    // so we don't offend the rate limit hence we throttle the requests
    requestCount++;

    var args = arguments;
    return new Promise(function (resolve) {
        setTimeout(function () {
            resolve.apply(this, args);
        }, Math.floor(requestCount / requestsPerSecond) * 4000);
    });
};

request({
    method: 'GET',
    url: contentTypeEndpoint,
    resolveWithFullResponse: true
})
    .then(function (resp) {
        requestsRemainingThisSecond = resp.headers['x-contentful-ratelimit-second-remaining'];
        requestsPerSecond = resp.headers['x-contentful-ratelimit-second-limit'];
        requestCount = requestsPerSecond - requestsRemainingThisSecond;

        typeSpec = JSON.parse(resp.body);
        showSuccess('Content type with name ' + typeSpec.name + ' has been found.');
    })
    .catch(function (err) {
        throwError(JSON.parse(err.error).message);
    })
    .then(function (filenames) {
        var filenames = path;
        return Promise.all(filenames.map(function (file) {
            return fsp.readFileAsync(file, 'utf8')
                .then(function (content) {
                    return {path: file, content: fm(content)};
                })
                .catch(function (err) {
                    throwError('transforming yaml - ' + JSON.stringify(err) + '\n>> ' + file, err);
                });
        }));
    })
    // map all the
    .then(function (files) {
        files = files.map(mapFile);
        files.forEach(validateFile);
        return files;
    })
    .then(function (files) {
        showProgress('starting upload of ' + files.length + ' files.');
        var sysVersion = 0;

        return Promise.all(files.map(function (file, index) {
            var data = file.content;
            showProgress('uploading file ' + file.path);
            var lowercasePage = data.fields.page['en-US'].toLowerCase().replace(/:/g, '');
            var entryHeaders = {};

            request({
                method: 'GET',
                url: contentfulApi + '/entries/' + lowercasePage,
                headers: {
                    'Authorization': 'Bearer ' + cmd.token
                },
                resolveWithFullResponse: false
            })
                .catch(function (err) {
                    console.log("Doesn't exist, that's OK - " + err);
                    // sysVersion = 0;
                })
                .then(function (resp) {
                    // if (sysVersion !== null){
                    //     // your code here.
                    //     sysObj = JSON.parse(resp);
                    //     sysVersion = sysObj.sys.version;
                    // }

                    console.log(sysVersion);
                    console.log(resp);
                    if (resp !== undefined) {
                        sysObj = JSON.parse(resp);
                        sysVersion = sysObj.sys.version;
                        entryHeaders = {
                            'Authorization': 'Bearer ' + cmd.token,
                            'X-Contentful-Content-Type': cmd.contentType,
                            'X-Contentful-Version': sysVersion
                        }
                    } else {
                        entryHeaders = {
                            'Authorization': 'Bearer ' + cmd.token,
                            'X-Contentful-Content-Type': cmd.contentType
                        };
                        sysVersion = 1;
                    }
                    console.log(entryHeaders);
                    var apiOptions = {
                        method: 'PUT',
                        json: true,
                        url: contentfulApi + '/entries/' + lowercasePage,
                        headers: entryHeaders,
                        body: {fields: data.fields},
                        resolveWithFullResponse: true
                    };

                    return rateLimitThrottle()
                        .then(function () {
                            return request(apiOptions);
                        })
                        .catch(function (err) {
                            var error = JSON.parse(err.message.replace(/^[^{]+/, ''));
                            throwApiError(error);
                        })
                        .then(function (resp) {
                            showSuccess('uploaded file ' + file.path);
                            return resp;
                        })
                        .then(function (entry) {
                            entry = entry.body;
                            get(entry, 'sys.id');
                            console.log(sysVersion);
                            if (cmd.publish) {
                                showProgress('publishing entry with id: "' + get(entry, 'sys.id') + '"');

                                return rateLimitThrottle()
                                    .then(function () {
                                        return request({
                                            method: 'PUT',
                                            resolveWithFullResponse: true,
                                            url: contentfulApi + '/entries/' + entry.sys.id + '/published',
                                            headers: {
                                                'Authorization': 'Bearer ' + cmd.token,
                                                'X-Contentful-Version': sysVersion
                                            }
                                        });
                                    })
                                    .catch(function (err) {
                                        var error = JSON.parse(err.response.body);
                                        var msg = 'couldn\'t publish entry with id: "' + entry.sys.id + '"';
                                        console.log(msg.red);
                                        throwApiError(error);
                                    })
                                    .then(function (resp) {
                                        var publishedEntry = JSON.parse(resp.body);
                                        // showSuccess('published entry ' + publishedEntry.fields.title[cmd.lang]);
                                        showSuccess('published entry ' + lowercasePage);
                                        return publishedEntry;
                                    });
                            }

                            return entry;
                        });


                })
        }));
    });

module.exports
