//Load static files
const config = require("./config.json");
const funcs = require("./funcs.js");

// FreePBX GraphQL Client
const {
	FreepbxGqlClient,
	gql
} = require("freepbx-graphql-client");
const pbxClient = new FreepbxGqlClient(config.freepbx.url, {
	client: {
		id: config.freepbx.clientid,
		secret: config.freepbx.secret,
	}
});

// Some functions for FreePBX

const createExtension = (ext, name, uid) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.generateQuery('lookup', {
			ext: ext
		})).then((result) => {
			// Extension exists
			res = {
				"status": "exists",
			}
			resolve(res);
		}).catch((error) => {
			// Extension does not exist, create it, reload, look it up, and return the result
			pbxClient.request(funcs.generateQuery('add', {
				ext: ext,
				name: name,
				uid: uid
			})).then((result) => {
				pbxClient.request(funcs.generateQuery('reload', {
					id: "CreateExt"
				})).then((result) => {
					pbxClient.request(funcs.generateQuery('lookup', {
						ext: ext
					})).then((result) => {
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

// deleteExtension, takes an extension number
const deleteExtension = (ext) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.generateQuery('delete', {
			ext: ext
		})).then((result) => {
			pbxClient.request(funcs.generateQuery('reload', {
				id: "DeleteExt"
			})).then((result) => {
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

const lookupExtension = (ident, type) => { // type is either "ext" or "uid"
	return new Promise((resolve, reject) => {
		switch (type) {
			case "ext":
				pbxClient.request(funcs.generateQuery('lookup', {
					ext: ident
				})).then((result) => {
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
				pbxClient.request(funcs.generateQuery('list', {})).then(async (result) => {
					// loop through all extensions, run a lookup on each one, and return the first one that matches
					var found = false;
					var ext = "";
					var count = 0;
					result.fetchAllExtensions.extension.forEach(async (ext) => {
						pbxClient.request(funcs.generateQuery('lookup', {
							ext: ext.user.extension
						})).then((result) => {
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
		pbxClient.request(funcs.generateQuery('list', {})).then((result) => {
			// Find the highest extension
			var highest = 0;
			// output looks like {fetchAllExtensions: { extension: [{user:{extension: 100, name: "Test"}}]}}
			// Look out for gaps in the extension numbers, if there are any, use that one, if not, use the highest + 1
			var exts = [];
			result.fetchAllExtensions.extension.forEach((ext) => {
				exts.push(ext.user.extension);
			});
			exts.sort((a, b) => a - b);
			for (var i = 0; i < exts.length; i++) {
				if (exts[i] != i + 100) {
					highest = i + 100;
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

dcClient.on('ready', () => {
	console.log(`Logged in as ${dcClient.user.tag}!`);
	// Set up application commands
	const commands = require('./commands.json');

	(async () => {
		try {
			console.log('Started refreshing application (/) commands.');
			await rest.put(
				Routes.applicationGuildCommands(dcClient.user.id, config.discord.guildId), {
					body: commands
				}
			);
			console.log('Successfully reloaded application (/) commands.');
		} catch (error) {
			console.error(error);
		}
	})();

});

dcClient.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;
	if (interaction.user.id != config.discord.devId) return; // Only allow the dev to use this bot (for now)
	const {
		commandName
	} = interaction;
	switch (commandName) {
		case "new":
			interaction.reply({
				content: "Please Wait...",
				ephemeral: true
			})
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
						let name = interaction.user.tag;
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
								// Add the role to the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.add(role);
							}
						}).catch((error) => {
							interaction.reply(`Error creating extension: ${error}`);
						});
					}
				}).catch((error) => {
					interaction.reply(`Error finding next available extension: ${error}`);
				});
			});
			break;
		case "whoami":
			interaction.reply({ content: "Please Wait...", ephemeral: true })
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
				console.log(error)
				interaction.editReply({
					content: "You don't have an extension!",
					ephemeral: true
				});
			});
			break;

		case "list":
			interaction.reply({
				content: "Not Implemented Yet",
				ephemeral: true
			})
			break;
		case "delete":
			if (interaction.options.get("confirm").value == false) {
				interaction.reply({
					content: "Please confirm you want to delete your extension by running `/delete confirm:true`",
					ephemeral: true
				})
				break;
			}
			interaction.reply({ content: "Please Wait...", ephemeral: true })
			lookupExtension(interaction.user.id, "uid").then((result) => {
				if (result.status == "exists") {
					// The user has an extension, delete it
					deleteExtension(result.result.fetchExtension.user.extension).then((result) => {
						if (result.status == "deleted") {
							interaction.editReply({
								content: "Extension Deleted!",
								ephemeral: true
							})
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
		default:
			break;
	}
});

dcClient.login(config.discord.token);