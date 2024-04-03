//Load static files
const config = require("./config.json");
const funcs = require("./funcs.js");
const colors = require("colors");
const embeds = require("./embeds.json")
const axios = require('axios');
const ping = require("ping")
var commandsBase = require("./commands.json")
const ssh2 = require('ssh2')
const sshConn = new ssh2.Client();
// find first file in .ssh local to the script
const fs = require('fs');
const path = require('path');
// get the first file in the .ssh directory
const keyPath = path.join(__dirname, '.ssh');
const keyFiles = fs.readdirSync(keyPath);
const keyFile = keyFiles[0];
// read the key file
const privateKey = fs.readFileSync(".ssh/" + keyFile, 'utf8');

// FreePBX GraphQL Client
const {
	FreepbxGqlClient,
	gql
} = require("freepbx-graphql-client");
var pbxClient = new FreepbxGqlClient(config.freepbx.url, {
	client: {
		id: config.freepbx.clientid,
		secret: config.freepbx.secret,
	}
});

// 50 minute interval to refresh the token
setInterval(() => {
	pbxClient = new FreepbxGqlClient(config.freepbx.url, {
		client: {
			id: config.freepbx.clientid,
			secret: config.freepbx.secret,
		}
	});
}, 3000000);

// Set up mariadb connection
const mariadb = require('mariadb');
const pool = mariadb.createPool(config.mariadb);
const cdrPool = mariadb.createPool(config.cdrdb);

// Some functions for FreePBX


const reload = () => {
	// We're gonna start converting all the old gql commands to using mysql `system fwconsole reload` query
	return new Promise((resolve, reject) => {
		sshConn.exec('fwconsole reload', (err, stream) => {
			if (err) {
				reject(err);
			}
			stream.on('data', (data) => {
				// is there a way to send this data without resolving the promise?
				console.log(data.toString());
			});
			stream.on('exit', (code, signal) => {
				if (code == 0) {
					resolve(code);
				} else {
					reject("Error reloading FreePBX");
				}
			})
		});
	});
}

const getExtCount = () => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then((result) => {
			resolve(result.fetchAllExtensions.extension.length);
		}).catch((error) => {
			reject(error);
		});
	});
}


const createExtension = (ext, name, uid) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
			ext: ext
		}))).then((result) => {
			// Extension exists
			res = {
				"status": "exists",
			}
			resolve(res);
		}).catch((error) => {
			// Extension does not exist, create it, reload, look it up, and return the result
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery('add', {
				ext: ext,
				name: name,
				uid: uid
			}))).then((result) => {
				reload().then((result) => {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
						ext: ext
					}))).then((result) => {
						res = {
							"status": "created",
							"result": result
						}
						resolve(res);
					}).catch((error) => {
						reject(error);
					});
				}).catch((error) => {
					reject(error);
				});
			}).catch((error) => {
				reject(error);
			});
		});
	});
}

const fixNames = () => { // Gonna leave this here if I ever need it in the future
	pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
		let extensions = result.fetchAllExtensions.extension;
		extensions.forEach((extension) => {
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery("lookup", {
				ext: extension.user.extension
			}))).then((result) => {
				// Get discord user
				dcClient.users.fetch(result.fetchVoiceMail.email).then((user) => {
					// Update extension name
					updateName(extension.user.extension, user.displayName).then((result) => {
						if (result.status == "updated") {
							sendLog(`${colors.green("[INFO]")} Updated extension ${extension.user.extension} name to ${user.displayName}`)
						}
					}).catch((error) => {
						sendLog(`${colors.red("[ERROR]")} ${error}`);
					});
				}).catch((error) => {
					sendLog(`${colors.red("[ERROR]")} ${error}`);
				});
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		});
	});
}

// deleteExtension, takes an extension number
const deleteExtension = (ext) => {
	return new Promise(async (resolve, reject) => {
		var conn = await cdrPool.getConnection();
		// delete from cel where cid_num = ext
		const row = await conn.query(`
		DELETE FROM cel
		WHERE cid_num = ${ext}
		`);
		conn.end();
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('delete', {
			ext: ext
		}))).then((result) => {
			reload().then((result) => {
				res = {
					"status": "deleted",
					"result": result
				}
				resolve(res);
			}).catch((error) => {
				reject(error);
			});
		}).catch((error) => {
			reject(error);
		});
	});
}

const updateName = (ext, name) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
			ext: ext
		}))).then((result) => {
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery('update_name', {
				ext: ext,
				name: name
			}))).then((result) => {
				reload().then((result) => {
					res = {
						"status": "updated",
						"result": result
					}
					resolve(res);
				}).catch((error) => {
					reject(error);
				});
			}).catch((error) => {
				reject(error);
			});
		}).catch((error) => {
			reject(error);
		});
	});
}

const generateExtensionListEmbed = async () => {
	return new Promise(async (resolve, reject) => {
		try {
			var conn = await cdrPool.getConnection();
			const result = await pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {})));
			let extensions = result.fetchAllExtensions.extension;
			let extensionList = {};

			// Generate a list of all unique extensions to be checked in the database
			let uniqueExtensions = [...new Set(extensions.map(extension => extension.user.extension))];

			// Construct SQL query to check all unique extensions at the same time
			const row30 = await conn.query(`
			SELECT cid_num, MAX(eventtime) 
			FROM cel 
			WHERE cid_num IN (${uniqueExtensions.join(",")}) 
			AND eventtime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
			GROUP BY cid_num
			`);

			const row90 = await conn.query(`
			SELECT cid_num, MAX(eventtime) 
			FROM cel 
			WHERE cid_num IN (${uniqueExtensions.join(",")}) 
			AND eventtime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
			GROUP BY cid_num
			`);
			// Get fresh/entirely unused extensions
			const alltime = await conn.query(`
			SELECT cid_num
			FROM cel
			WHERE cid_num IN (${uniqueExtensions.join(",")})
			GROUP BY cid_num
			`);
			// turn rows into an array of extension numbers
			let active30 = row30.map(row => row.cid_num);
			let active90 = row90.map(row => row.cid_num);
			let used = alltime.map(row => row.cid_num);


			// Generate inactiveFlag object, if it's a fresh extension set the flag to -

			let inactiveFlag = {};
			uniqueExtensions.forEach((ext) => {
				if (used.includes(ext)) {
					if (active30.includes(ext)) {
						if (active90.includes(ext)) {
							inactiveFlag[ext] = "";
						} else {
							inactiveFlag[ext] = "**";
						}
					} else {
						inactiveFlag[ext] = "*";
					}
				} else {
					inactiveFlag[ext] = "-";
				}
			});

			extensions.forEach((extension) => {
				extensionList[extension.user.extension] = extension.user.name;
			});

			// fullList will contain embeds, each embed will contain one field with as many extensions as it can fit (up to 1024 characters). Once the feild is full, make a new embed in the array without a title, just a description. The firrst embed will have a title
			let field = "";
			let embeds = [];
			let count = 0;

			// put for loop in function and await it
			embeds.push({
				"title": "Extension List",
				"color": 0x00ff00,
				"description": `${extensions.length} extensions\n\`* = inactive for 30 days\`\n\`** = inactive for 90 days\`\n\`- = never used\``,
				timestamp: new Date()
			})
			await (async () => {
				for (let key in extensionList) {
					field += `\`${key}${inactiveFlag[key]}\`: ${extensionList[key]}\n`;
					if (field.length >= 1024) {
						// cut feilds at nearest newline and push to the embed
						let lastNewline = field.lastIndexOf("\n", 1024);
						embeds[count].fields = [{
							"name": "Extensions",
							"value": field.slice(0, lastNewline)
						}];
						embeds.push({
							"color": 0x00ff00,
							"feilds": [
								{
									"name": "Extensions (extended)",
									"value": field,
									timestamp: new Date()
								}
							]
						});
						// figure out any extensions that got cut off and add them to the next embed
						field = field.slice(lastNewline);
						count++;
					}
					embeds[count].fields = [{
						"name": "Extensions",
						"value": field
					}];
				}
			})();


			// for (let key in extensionList) {
			// 	extensionList1 += `\`${key}${inactiveFlag[key]}\`: ${extensionList[key]}\n`;
			// }

			//});
			res = embeds;
			// res = {
			// 	"title": "Extension List",
			// 	"color": 0x00ff00,
			// 	"description": `${extensions.length} extensions\n\`* = inactive for 30 days\`\n\`** = inactive for 90 days\`\n\`- = never used\``,
			// 	"fields": [{
			// 		"name": "Extensions",
			// 		"value": `${extensionList1}`
			// 	}],
			// 	"timestamp": new Date()
			// }
			conn.end();
			resolve(res);
		} catch (error) {
			reject(error);
		}
	});
};

const lookupExtension = (ident, type) => { // type is either "ext" or "uid"
	return new Promise((resolve, reject) => {
		switch (type) {
			case "ext":
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
					ext: ident
				}))).then((result) => {
					res = {
						"status": "exists",
						"result": result
					}
					resolve(res);
				}).catch((error) => {
					res = {
						"status": "notfound",
						"result": error
					}
					reject(res);
				});
				break;
			case "uid":
				// Find the extension based on Discord ID in the voicemail email field
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then(async (result) => {
					// loop through all extensions, run a lookup on each one, and return the first one that matches
					var found = false;
					var ext = "";
					var count = 0;
					result.fetchAllExtensions.extension.forEach(async (ext) => {
						pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
							ext: ext.user.extension
						}))).then((result) => {
							if (result.fetchVoiceMail.email == ident && !found) {
								found = true;
								ext = result;
								clearInterval(x);
								resolve({
									"status": "exists",
									"result": ext
								})
							}
							count++;
						}).catch((error) => {
							reject(error);
						});
					});
					x = setInterval(() => {
						if (count == result.fetchAllExtensions.extension.length) {
							clearInterval(x);
							if (!found) {
								reject("Not found");
							}
						}
					}, 100);

				}).catch((error) => {
					reject(error);
				});
				break;
			default:
				reject("Invalid type");
		}
	});
}

const findNextExtension = () => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then((result) => {
			// Find the highest extension
			var highest = 0;
			// output looks like {fetchAllExtensions: { extension: [{user:{extension: 100, name: "Test"}}]}}
			// Look out for gaps in the extension numbers, if there are any, use that one, if not, use the highest + 1
			var exts = [];
			result.fetchAllExtensions.extension.forEach((ext) => {
				exts.push(Number(ext.user.extension));
			});
			exts.sort((a, b) => a - b);
			// Find duplicate extensions and remove all but the first
			for (var i = 0; i < exts.length; i++) {
				if (exts[i] == exts[i + 1]) {
					exts.splice(i, 1);
					i--;
				}
			}



			// Start should be the lowest extension. If none exists use config value
			// Await if statement
			var start = 0;
			if (exts.length > 0) {
				start = exts[0];
			} else {
				start = config.freepbx.startExt;
				exts[0] = start - 1;
			}
			for (var i = 0; i < exts.length; i++) {
				if (exts[i] != i + config.freepbx.startExt) {
					highest = i + start;
					break;
				}
			}
			if (highest == 0) {
				highest = String(Number(exts[exts.length - 1]) + 1);
			}

			// Return the next extension
			res = {
				"status": "success",
				"result": String(highest)
			}
			resolve(res);
		}).catch((error) => {
			reject(error);
		});
	});
}

// Load Discord.js
const Discord = require("discord.js");
const {
	REST,
	Routes
} = require('discord.js');
const dcClient = new Discord.Client({
	intents: ["Guilds", "GuildMembers"]
});
const rest = new REST({
	version: '10'
}).setToken(config.discord.token);
var logChannel;
var sendLog;
var logMsg = null; // Used to store the log message, so it can be edited instead of sending a new one
var curMsg = ""; // Used to calculate the length of the log message, so it can be edited instead of sending a new one
dcClient.on('ready', async () => {
	await dcClient.channels.fetch(config.discord.logId).then(async (channel) => {
		await channel.send(`\`\`\`ansi\n${curMsg}\`\`\``).then((msg) => {
			logMsg = msg;
		});
		sendLog = async (message) => {
			let timestamp = new Date()
			message = `[${timestamp.toLocaleString()}] ${message}`;
			if (curMsg.length + message.length <= 2000) {
				curMsg = `${curMsg}\n${message}`;
				await logMsg.edit(`\`\`\`ansi\n${curMsg}\`\`\``);
			} else {
				curMsg = message;
				await channel.send(`\`\`\`ansi\n${message}\`\`\``).then((msg) => {
					logMsg = msg;
				});
			}
			console.log(message);
		};

		sendLog(`${colors.cyan("[INFO]")} Logged in as ${dcClient.user.displayName}!`);

		const pageGroups = require('./pageGroups.json');
		const pageCommand = {
			"name": "paging",
			"description": "Add/Remove yourself from paging groups",
			"type": 1,
			"options": [
				{
					"name": "method",
					"description": "The method to use",
					"type": 3,
					"required": true,
					"choices": [
						{
							"name": "add",
							"value": "add"
						},
						{
							"name": "remove",
							"value": "remove"
						}
					]
				},
				{
					"name": "group",
					"description": "The group to add/remove yourself from",
					"type": 3,
					"required": true,
					"choices": pageGroups
				}
			]
		};

		// make a non reference copy of the commands object
		var commands = JSON.parse(JSON.stringify(commandsBase));
		commands.push(pageCommand);


		(async () => {
			try {
				sendLog(`${colors.cyan("[INFO]")} Started refreshing application (/) commands.`);
				await rest.put(
					Routes.applicationGuildCommands(dcClient.user.id, config.discord.guildId), {
					body: commands
				}
				);
				sendLog(`${colors.cyan("[INFO]")} Successfully reloaded application (/) commands.`);
			} catch (error) {
				console.error(`${colors.red("[ERROR]")} ${error}`);
			}
		})();

		// Presence Stuff
		getExtCount().then((result) => {
			dcClient.user.setPresence({
				activities: [{
					name: `${result} extensions`,
					type: "WATCHING"
				}],
				status: "online"
			});
		}).catch((error) => {
			sendLog(`${colors.red("[ERROR]")} ${error}`);
		});

		// Run every 5 minutes
		setInterval(() => {
			getExtCount().then((result) => {
				dcClient.user.setPresence({
					activities: [{
						name: `${result} extensions`,
						type: "WATCHING"
					}],
					status: "online"
				});
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		}, 300000);

		// Lookup all extensions and check if they're still in the server
		// If they're not, delete them
		// Run once on startup
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
			let extensions = result.fetchAllExtensions.extension;
			extensions.forEach((extension) => {
				lookupExtension(extension.user.extension, "ext").then((result) => {
					if (result.result.fetchVoiceMail.email == null) {
						// Extension is not part of the bot, do nothing
						return;
					};
					// Fetch Discord user using ID stored in result.result.fetchVoiceMail.email, and see if they're in the server
					dcClient.guilds.cache.get(config.discord.guildId).members.fetch(result.result.fetchVoiceMail.email).then((member) => {
						// They're in the server, do nothing
					}).catch((error) => {
						// They're not in the server, delete the extension
						sendLog(`${colors.cyan("[INFO]")} ${extension.user.extension} is not in the server, deleting it`);
						deleteExtension(extension.user.extension).then((result) => {
							sendLog(`${colors.cyan("[INFO]")} Deleted extension ${extension.user.extension} because the user is no longer in the server`);
						}).catch((error) => {
							sendLog(`${colors.red("[ERROR]")} ${error}`);
						});
					});

				});
			});
		})

		// Run every 5 minutes
		const extListChannel = dcClient.channels.cache.get(config.discord.extList);
		// Find the latest message from the bot in extListChannel, if there isn't one, send one. There can be other messages in the channel
		// Sends the same message as the list command
		setInterval(async () => {
			// run this goofy query just to make sure everything is happy
			/*
			DELETE FROM devices
			WHERE id NOT IN (SELECT extension FROM users);
			*/
			// This will delete any devices that don't have a corresponding user
			// This is a safety measure to prevent orphaned devices (it breaks the API entirely if there are any)
			const conn = await pool.getConnection();
			const row = await conn.query(`
			DELETE FROM devices
			WHERE id NOT IN (SELECT extension FROM users);
			`).then((result) => {
				conn.end();
			});


			await extListChannel.messages.fetch({
				limit: 1
			}).then((messages) => {
				if (messages.size == 0) {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
						}
						generateExtensionListEmbed().then(embed => {
							extListChannel.send({
								content: "",
								embeds: embed
							});
						})
					})
				} else {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
						}
						generateExtensionListEmbed().then(embed => {
							messages.first().edit({
								content: "",
								embeds: embed
							});
						});
					})
				}
			})
		}, 300000);
		// Also run on startup
		extListChannel.messages.fetch({
			limit: 1
		}).then((messages) => {
			if (messages.size == 0) {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
					}
					generateExtensionListEmbed().then(embed => {
						extListChannel.send({
							content: "",
							embeds: embed
						});
					});
				})
			} else {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
					}
					generateExtensionListEmbed().then(embed => {
						messages.first().edit({
							content: "",
							embeds: embed
						});
					});
				})
			}
		})

	});

	// Uptime Kuma Ping
	// Calculate ping to Discord API

	// Every X seconds (defined in config.status.interval), send a ping to Uptime Kuma, send push request to config.status.url
	setInterval(() => {
		// Send a ping to Uptime Kuma
		// Send a push request to config.status.url
		// Define URL arguments ?status=up&msg=OK&ping=

		// Calculate ping to Discord API
		const start = Date.now();
		axios.get("https://discord.com/api/gateway").then((result) => {
			const latency = Date.now() - start;
			axios.get(config.status.url + `?status=up&msg=OK&ping=${latency}`).then((result) => {
				//sendLog(`${colors.cyan("[INFO]")} Sent ping to Uptime Kuma`);
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} Error sending ping ${error}`);
			});
		})
	}, config.status.interval * 1000);
	const start = Date.now();
	axios.get("https://discord.com/api/gateway").then((result) => {
		const latency = Date.now() - start;
		axios.get(config.status.url + `?status=up&msg=OK&ping=${latency}`).then((result) => {
			//sendLog(`${colors.cyan("[INFO]")} Sent ping to Uptime Kuma`);
		}).catch((error) => {
			sendLog(`${colors.red("[ERROR]")} Error sending ping ${error}`);
		});
	})

	// Start doing SSH stuff
	sendLog(`${colors.cyan("[INFO]")} Starting SSH connection`);
	await sshConn.connect({
		host: config.freepbx.server,
		username: "root", // Will make config later
		privateKey: privateKey
	})

});

sshConn.on('ready', () => {
	sendLog(`${colors.cyan("[INFO]")} SSH connection established`);
	console.log("Reloading PBX")
	reload().then((result) => {
		console.log("Reloaded PBX")
	}).catch((error) => {
		console.log("Error reloading PBX")
		console.log(error)
	});
});

dcClient.on("guildMemberRemove", (member) => {
	// Delete the extension if the user leaves the server
	sendLog(`${colors.cyan("[INFO]")} User ${member.id} left the server`)
	lookupExtension(member.id, "uid").then((result) => {
		if (result.status == "exists") {
			sendLog(`${colors.cyan("[INFO]")} User ${member.id} has extension ${result.result.fetchExtension.user.extension}, deleting it`)
			deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
				sendLog(`${colors.cyan("[INFO]")} Deleted extension ${result.result.fetchExtension.user.extension} because the user left the server`);
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		}
	}).catch((error) => {
		sendLog(`${colors.red("[ERROR]")} ${error}`);
	});
});

dcClient.on('interactionCreate', async interaction => {
	if (interaction.isCommand()) {
		const {
			commandName
		} = interaction;
		switch (commandName) {
			case "new":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "You already have an extension!",
							ephemeral: true
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.user.id;
							let ext = result.result;
							let name = interaction.user.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Created extension ${ext} for user ${uid}`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.member.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "whoami":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}],
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;

			case "list":
				await interaction.deferReply({
					ephemeral: false
				});
				generateExtensionListEmbed().then((result) => {
					interaction.editReply({
						content: "",
						embeds: result
					});
				}).catch((error) => {
					interaction.editReply(`Error generating extension list: ${error}`);
				});
				break;
			case "delete":
				if (interaction.options.get("confirm").value == false) {
					interaction.reply({
						content: "Please confirm you want to delete your extension by running `/delete confirm:true`",
						ephemeral: true
					})
					break;
				}
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((result) => {
							if (result.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.remove(role);
							}
						}).catch((error) => {
							interaction.reply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "button":
				interaction.channel.send({
					embeds: embeds.controls,
					components: [{
						type: 1,
						components: [{
							type: 2,
							label: "Get an Extension",
							emoji: {
								name: "✅"
							},
							style: 3,
							custom_id: "new"
						},
						{
							type: 2,
							label: "Get your extension info",
							emoji: {
								name: "ℹ️"
							},
							style: 1,
							custom_id: "whoami"
						},
						{
							type: 2,
							label: "Delete your extension",
							emoji: {
								name: "❌"
							},
							style: 4,
							custom_id: "delete"
						},
						]
					}]
				}).then(() => {
					interaction.reply({
						content: "Button sent!",
						ephemeral: true
					})
				});
				break;
			case "name": // Update the users extension name, name is optional and defaults to the users Discord displayName
				// sanity check the name, remove any quotes, escape any escape characters
				let name;
				if (!interaction.options.get("name")) {
					name = interaction.user.displayName;
				} else {
					name = interaction.options.get("name").value;
				}
				name = name.replace(/"/g, "");
				name = name.replace(/\\/g, "\\\\"); // Fuck you cayden

				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, update the name
						updateName(result.result.fetchExtension.user.extension, name).then((result2) => {
							if (result2.status == "updated") {
								interaction.editReply({
									content: "Extension Name Updated!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) updated extension ${result.result.fetchExtension.user.extension} name to ${name}`)
							}
						}).catch((error) => {
							interaction.editReply(`Error updating extension name: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "paging": // Add/Remove yourself from paging groups
				var conn = await pool.getConnection();
				await interaction.deferReply({
					ephemeral: true
				});
				// Get the users extension, if they don't have one, return an ephemeral message saying so
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, add/remove them from the paging group
						let ext = result.result.fetchExtension.user.extension;
						let group = interaction.options.get("group").value;
						let method = interaction.options.get("method").value;
						switch (method) {
							case "add":
								// Check the db if they're already in the group
								conn.query(`SELECT * FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
									if (result.length == 0) {
										// They're not in the group, add them
										conn.query(`INSERT INTO paging_groups (\`ext\`, \`page_number\`) VALUES (${ext}, ${group})`).then((result) => {
											reload().then(() => {
												interaction.editReply({
													content: "Added you to the paging group!",
													ephemeral: true
												});
												sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) added themselves to paging group ${group}`)
											});
										}).catch((error) => {
											interaction.editReply(`Error adding you to the paging group: ${error}`);
											sendLog(`${colors.red("[ERROR]")} ${error}`);
										});
									} else {
										// They're already in the group, return an ephemeral message saying so
										interaction.editReply({
											content: "You're already in that paging group!",
											ephemeral: true
										});
									}
								}).catch((error) => {
									interaction.editReply(`Error adding you to the paging group: ${error}`);
									sendLog(`${colors.red("[ERROR]")} ${error}`);
								});
								break;
							case "remove":
								// Check if they're in the group
								conn.query(`SELECT * FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
									if (result.length == 0) {
										// They're not in the group, return an ephemeral message saying so
										interaction.editReply({
											content: "You're not in that paging group!",
											ephemeral: true
										});
									} else {
										// They're in the group, remove them
										conn.query(`DELETE FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
											reload().then(() => {
												interaction.editReply({
													content: "Removed you from the paging group!",
													ephemeral: true
												});
												sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) removed themselves from paging group ${group}`)
											});
										}).catch((error) => {
											interaction.editReply(`Error removing you from the paging group: ${error}`);
											sendLog(`${colors.red("[ERROR]")} ${error}`);
										});
									}
								}).catch((error) => {
									interaction.editReply(`Error removing you from the paging group: ${error}`);
									sendLog(`${colors.red("[ERROR]")} ${error}`);
								});
								break;
						}
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so, and how to get one (/new)
					interaction.editReply({
						content: "You don't have an extension! Run `/new` to get one!",
						ephemeral: true
					});
				})
				conn.end();
				break;

			case "admin": // Admin commands
				// switch subcommand
				switch (interaction.options.getSubcommand()) {
					case "silence": // SSH run `asterisk -x "channel request hangup all"

						sshConn.exec("asterisk -x 'channel request hangup all'", (err, stream) => {
							if (err) {
								interaction.reply({
									content: `Error killing calls: ${err}`,
									ephemeral: true
								});
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							stream.on("exit", (code) => {
								interaction.reply({
									content: "Killed all calls!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} Silenced all channels`);
							})
						});
						break;
					case "reload": // Reload asterisk and freepbx
						await interaction.deferReply({
							ephemeral: true
						});
						// We got two commands to run to be safe
						sshConn.exec("fwconsole reload", (err, stream) => {
							if (err) {
								interaction.editReply(`Error reloading FreePBX: ${err}`);
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							stream.on('exit', (code, signal) => {
								sshConn.exec("asterisk -x 'core reload'", (err, stream) => {
									if (err) {
										interaction.editReply(`Error reloading Asterisk: ${err}`);
										sendLog(`${colors.red("[ERROR]")} ${err}`);
									}
									stream.on('exit', (code, signal) => {
										interaction.editReply("Reloaded FreePBX and Asterisk!");
										sendLog(`${colors.green("[INFO]")} Reloaded FreePBX and Asterisk`);
									});
								});
							});
						});
						break;
					case "reboot": // Reboot the whole server (last resort, after this happens kill all connections to the server, then set a 1m timer to kill the bot)
						await interaction.deferReply({
							ephemeral: true
						});
						sshConn.exec("reboot", (err, stream) => {
							if (err) {
								interaction.editReply(`Error rebooting server: ${err}`);
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							stream.on('exit', (code, signal) => {
								interaction.editReply("Rebooting server...\nThe bot will now disconnect and restart in 1 minute. Please stand by...").then(() => {
									sendLog(`${colors.green("[INFO]")} Rebooting server`);
									dcClient.destroy().then(() => {
										console.log("Disconnected from Discord");
									});
									conn.end().then(() => {
										console.log("Disconnected from MySQL");
									});
									sshConn.end();
									console.log("Disconnected from SSH")
									setTimeout(() => {
										process.exit();
									}, 60000);
								});
							});
						});
				}
				break;
			case "dev": // Developer commands
				// check if the user is a developer
				if (!config.discord.developers.includes(interaction.user.id)) {
					interaction.reply({
						content: "You're not a developer!",
						ephemeral: true
					});
					break;
				}

				// switch subcommand
				switch (interaction.options.getSubcommand()) {
					case "fwconsole": // Run a fwconsole command
						await interaction.deferReply({
							ephemeral: true
						});
						let cmd = interaction.options.get("command").value;
						sshConn.exec(`fwconsole ${cmd}`, (err, stream) => {
							if (err) {
								interaction.editReply(`Error running command: ${err}`);
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							outputStream = ""
							stream.on("data", (data) => {
								outputStream += `${data}`
							})
							stream.on('exit', (code, signal) => {
								// generate message json
								const msgJson = {
									content: `Ran command \`${cmd}\`\n\`\`\`ansi\n${outputStream}\`\`\``
								}
								// outputStream is too long for Discord, so we need to send it as a file
								if (outputStream.length > 2000) {
									// make the buffer
									const buffer = Buffer.from(outputStream, 'utf-8');
									const attachment = {
										name: "output.txt",
										attachment: buffer
									}
									msgJson.files = [attachment];
									msgJson.content = `Ran command \`${cmd}\`\nOutput too long, sending as a file`
								}
								interaction.editReply(msgJson);
								sendLog(`${colors.green("[INFO]")} Ran command ${cmd}`);
							});
						});
						break;
					case "restart": // Restart the bot
						await interaction.reply({
							content: "Restarting the bot...",
							ephemeral: true
						})
						sendLog(`${colors.green("[INFO]")} Restarting the bot`);
						dcClient.destroy().then(() => {
							console.log("Disconnected from Discord");
						});
						conn.end().then(() => {
							console.log("Disconnected from MySQL");
						});
						sshConn.end();
						console.log("Disconnected from SSH")
						setTimeout(() => {
							process.exit();
						}, 1000);
						break;
					case "asterisk": // Asterisk CLI command
						await interaction.deferReply({
							ephemeral: true
						});
						let cmd2 = interaction.options.get("command").value;
						sshConn.exec(`asterisk -x '${cmd2}'`, (err, stream) => {
							if (err) {
								interaction.editReply(`Error running command: ${err}`);
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							outputStream = ""
							stream.on("data", (data) => {
								outputStream += `${data}`
							})
							stream.on('exit', (code, signal) => {
								// generate message json
								const msgJson = {
									content: `Ran command \`${cmd2}\`\n\`\`\`ansi\n${outputStream}\`\`\``
								}
								// outputStream is too long for Discord, so we need to send it as a file
								if (outputStream.length > 2000) {
									// make the buffer
									const buffer = Buffer.from(outputStream, 'utf-8');
									const attachment = {
										name: "output.txt",
										attachment: buffer
									}
									msgJson.files = [attachment];
									msgJson.content = `Ran command \`${cmd2}\`\nOutput too long, sending as a file`
								}
								interaction.editReply(msgJson);
								sendLog(`${colors.green("[INFO]")} Ran command ${cmd2}`);
							});
						});
						break;
					case "shell": // This is dangerous, only allow developers to use it
						await interaction.deferReply({
							ephemeral: true
						});
						let cmd3 = interaction.options.get("command").value;
						// TODO: Timeout
						//let cmd3timeout = interaction.options.get("timeout").value;
						sshConn.exec(cmd3, (err, stream) => {
							if (err) {
								interaction.editReply(`Error running command: ${err}`);
								sendLog(`${colors.red("[ERROR]")} ${err}`);
							}
							// if timeout is set, set a timeout before
							//timeout = setTimeout(() => {
							//	stream.close();
							//	interaction.editReply(`Command timed out after ${cmd3timeout}ms`);
							//})
							outputStream = ""
							stream.on("data", (data) => {
								outputStream += `${data}`
							})
							stream.on('exit', (code, signal) => {
								// clear the timeout
								//clearTimeout(timeout);
								// generate message json
								const msgJson = {
									content: `Ran command \`${cmd3}\`\n\`\`\`ansi\n${outputStream}\`\`\``
								}
								// outputStream is too long for Discord, so we need to send it as a file
								if (outputStream.length > 2000) {
									// make the buffer
									const buffer = Buffer.from(outputStream, 'utf-8');
									const attachment = {
										name: "output.txt",
										attachment: buffer
									}
									msgJson.files = [attachment];
									msgJson.content = `Ran command \`${cmd3}\`\nOutput too long, sending as a file`
								}
								interaction.editReply(msgJson);
								sendLog(`${colors.green("[INFO]")} Ran command ${cmd3}`);
							});
						});
						break;
				}
				break;
			default:
				break;
		}
	}
	if (interaction.isButton()) {
		switch (interaction.customId) {
			case "new":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "You already have an extension!",
							ephemeral: true
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.user.id;
							let ext = result.result;
							let name = interaction.user.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Created extension ${ext} for user ${uid}`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.member.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "delete":
				interaction.reply({
					content: "Are you sure you want to delete your extension?\nThis action is **irreversible**!\nAll voicemails, call history, and other data will be **permanently deleted**!\n\n**Only do this if you're absolutely sure you want to delete your extension!**",
					ephemeral: true,
					components: [{
						type: 1,
						components: [{
							type: 2,
							label: "Yes",
							emoji: {
								name: "✅"
							},
							style: 4,
							custom_id: "delete2"
						}]
					}]
				}).then(() => {
					setTimeout(() => {
						try {
							interaction.deleteReply();
						} catch (error) {
							// ignore
						}
					}, 10000);
				});
				break;
			case "delete2":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
							if (delResult.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.remove(role);
							}
						}).catch((error) => {
							// sendLog full error with line number

							interaction.editReply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "whoami":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}],
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
		}
	}
	if (interaction.isUserContextMenuCommand()) {
		switch (interaction.commandName) {
			case "Lookup Extension":
				// Get the extension for the user if they have one
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: `${interaction.targetUser} has extension \`${result.result.fetchExtension.user.extension}\``,
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "That user doesn't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "Create Extension": // Create an extension for the user, if they have one, return the extension info
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}]
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.targetId;
							let ext = result.result;
							let name = interaction.targetUser.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Admin ${interaction.user.displayName} Created extension ${ext} for user ${interaction.targetUser.displayName} (${interaction.targetId})`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.targetMember.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "Delete Extension": // Delete the users extension, if they have one
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
							if (delResult.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} deleted ${interaction.targetUser.username}'s extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.targetMember.roles.remove(role);
							}
						}).catch((error) => {
							// sendLog full error with line number

							interaction.editReply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "That user doesn't have an extension!",
						ephemeral: true
					});
				});
				break;
		}
	}
});

// Lets actually handle exceptions now
process.on('unhandledRejection', (error) => {
	// Log a full error with line number
	sendLog(`${colors.red("[ERROR]")} ${error}`);
	// If config.ntfyUrl is set, Send the exception to ntfy
	if (config.ntfyUrl) fetch(config.ntfyUrl, {
		method: 'POST', // PUT works too
		body: error,
		headers: {
			'Title': 'FreePBX Bot Rejection',
			'Priority': 5,
			'Tags': 'warning,phone,FreePBX Manager'
		}
	});
});

process.on('uncaughtException', (error) => {
	// Log a full error with line number
	sendLog(`${colors.red("[ERROR]")} ${error}`);
	// If config.ntfyUrl is set, Send the exception to ntfy
	if (config.ntfyUrl) fetch(config.ntfyUrl, {
		method: 'POST', // PUT works too
		body: error,
		headers: {
			'Title': 'FreePBX Bot Exception',
			'Priority': 5,
			'Tags': 'warning,phone,FreePBX Manager'
		}
	});
});

dcClient.login(config.discord.token);