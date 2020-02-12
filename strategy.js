"use strict";
const passport = require( "passport-strategy" );
var speakeasy = require( "speakeasy" );
var _ = require( "lodash" );
var validate = require( "./lib/util" ).validate;
var bcrypt = require( "bcrypt" );
var moment = require( "moment" );
var err = err => {
	throw new Error( err );
};
function makeid ( length ) {
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for ( var i = 0; i < length; i++ ) {
		result += characters.charAt( Math.floor( Math.random() * charactersLength ) );
	}
	return result;
}
//Strategy Constructor
const Strategy = function ( options, verify ) {
	if ( typeof options == "function" ) {
		verify = options;
		options = {};
	}
	this.callbackURL = options.callbackPath;
	passport.Strategy.call( this );
	this._verify = verify;
	this._messageProvider = options.messageProvider; // This is custom sms service callback function, if it is not provided then defaut twilioService will be used.
	if ( !this._messageProvider ) {
		err( `Override method messageProvider(type,data,token) in your passport.js` );
	}
	this._modelName = options.otpModel || "Otp";
	this.entryFlow = options.entryFlow || false;
	this.phoneVerReq = _.get( this.entryFlow, `phoneVerificationRequired`, false );
	this.emailVerReq = _.get( this.entryFlow, `emailVerificationRequired`, false );
	if ( this.entryFlow ) {
		this.entryFlow = true;
	}
	this.passOptions = options.passOptions || false;
	// this._window = options.window || 6;
	this._resendEnabled = options.resendEnabled || true;
	this._resendAfter = options.resendAfter || false;
	this.defaultCountryCode = options.defaultCountryCode || false;
	if ( !this._resendAfter ) {
		err( `Provide resendAfter interval in authConfig.json` );
	}
	this._otpDigits = options.digits;
	this.method = options.method || "multiOr";

	this._verificationRequired = options.verificationRequired && true;
	this._totpData = {
		encoding: "base32",
		window: 4,
		digits: this._otpDigits
	};
	this._UserModel = options.UserModel;
	this.redirectEnabled = options.redirectEnabled || false;
	this.strictOtp = options.strictOtp;
	this.provider = options.provider;
};

Strategy.prototype.authenticate = async function ( req, options ) {
	if ( !req.app.models[ this._modelName ] ) {
		console.error(
			"Model " +
			this._modelName +
			" doesn't exist.\nPossible Solution --------->\n" +
			"1. Create a model with schema as follow: " +
			'phone(string), secret(string).\n2. Pass the name of model/collection in the authConfig.json file under the "otp" module configuration as follows:\n' +
			'```\n"otpModel":"YOUR MODEL NAME"\n```\n'
		);

		return req.res.json( {
			status: 400,
			message: "error occured"
		} );
	}
	req.app.models[ this._modelName ].belongsTo( this._UserModel, {
		as: "user",
		foreignKey: "userId"
	} );

	//Request must contain body
	try {
		if ( !req.body ) {
			return req.res.json( {
				status: 400,
				message: `BODY_NOT_FOUND`
			} );
		}

		const self = this;
		let email = req.body.email || false;
		let phone = req.body.phone || false;
		let res = req.res;
		let Otp = req.app.models[ this._modelName ];
		let User = this._UserModel;
		let data = {};
		if ( email ) {
			await validate( email, "email" );
			data.email = email;
		}

		if ( phone ) {
			if ( !phone.countryCode || !phone.phone ) {
				// && instead of || ??
				return res.json( {
					status: 400,
					message: `INVALID_PHONE_DATA`
				} );
			}
			phone.countryCode = phone.countryCode || this.defaultCountryCode;
			await validate( [ phone.countryCode, phone.phone ], "phone" );
			data.phone = phone;
		} else {
			//.....
			if ( !email && !req.body.password ) err( `PROVIDE_EMAIL_OR_PHONE` );
			if ( req.body.password && req.body.userIns && req.body.token ) {
				//password change request
				//validate the token
				//checks are only given for existing email always there
				try {
					await validate(
						{
							options: this.passOptions,
							pass: req.body.password
						},
						"pass"
					);
					let data = {};
					let userIns = req.body.userIns;
					// verifyToken method accepts either email, phone, or multi 
					// in `passwordUpdate` case token can be either phone's or email
					// therefore checking for both email and phone according to the availibility
					// Assuming that this endpoint is recieving only single token
					data.email = req.body.userIns.email;
					data.phone = req.body.userIns.phone.phone && req.body.userIns.phone;
					let resultEmail;
					let errObj = {};
					if ( data.email ) {
						//check for email
						let token = req.body.token;
						try {
							resultEmail = await this.verifyToken( req, data, token, "email" );
						} catch ( error ) {
							errObj.email = error.message || error;
							resultEmail = false;
						}
					}
					let resultPhone;
					if ( data.phone ) {
						//check for email
						let token = req.body.token;
						try {
							resultPhone = await this.verifyToken( req, data, token, "phone" );
						} catch ( error ) {
							errObj.phone = error.message || error;
							resultPhone = false;
						}
					}

					// let token = req.body.token;
					// let result = await this.verifyToken(req, data, token, "email");
					if ( resultEmail || resultPhone ) {
						let result = resultEmail || resultPhone;
						if ( result.userId.toString() === userIns.id ) {
							let user = await User.findById( userIns.id );
							let incomingAccessToken = req.body.extras.options && req.body.extras.options.accessToken;
							if ( !incomingAccessToken ) {
								[ incomingAccessToken ] = await user.accessTokens.find( { limit: 1, order: "id DESC" } );
							}
							await user.setPassword( req.body.password, {
								accessToken: incomingAccessToken
							} );
							await user.updateAttributes( { passwordSetup: true } );
							//todo pass
							return req.res.json( {
								status: 200,
								message: user.toJSON()
							} );
						}
						else {
							console.log( `Invalid userId` );
							err( `Invalid userId` );
						}
					}
					else {
						if ( errObj ) {
							throw errObj;
						}
					}
				} catch ( error ) {
					return req.res.json( {
						status: 400,
						message: error.message || error
					} );
				}
			} else {
				phone = { countryCode: false, phone: false };
				data.phone = phone;
			}
		}
		let type;
		if ( data.phone && data.phone.phone ) {
			type = "phone";
		}
		if ( data.email ) {
			type = "email";
		}
		if ( data.phone && data.phone.phone && data.email ) {
			type = "multi";
		}

		if ( req.body.token ) {
			return await self.submitToken.call( self, req, data, req.body.token, type );
		}
		let userIns = req.body.userIns;

		let query = getQuery.call( this, "or", email, phone );
		console.log( query );
		let otpObj = { ...data };
		if ( req.body.password ) {
			await validate(
				{ options: this.passOptions, pass: req.body.password },
				"pass"
			);
			otpObj.password = User.hashPassword( req.body.password );
		}
		let returnResp = {};
		this._reqBody = req.body;
		if ( email && phone && phone.phone ) {
			await checkReRequestTime.call( this, req, { email, phone }, "and" );
			let { secret, token } = createNewToken( this._totpData );
			let otpData = {};

			otpData.secretEmail = secret;
			otpData.email = email;
			let tokenEmail = token;
			let secTokTmp = createNewToken( this._totpData );
			secret = secTokTmp.secret;
			token = secTokTmp.token;
			otpData.secretPhone = secret;
			otpData.phone = phone;
			let tokenPhone = token;
			let otp;
			async function createOtpInstance ( done ) {
				try {
					otp = await Otp.findOrCreate(
						getQuery.call( self, "and", email, phone ),
						otpData
					);
					done();
				} catch ( error ) {
					done( error );
				}
			}
			User.notifyObserversAround( 'otp instance', otpData, createOtpInstance, async function ( err ) {
				if ( err ) throw err;
				if ( otp[ 1 ] === true ) {
					if ( userIns ) {
						await otp[ 0 ].updateAttribute( "userId", userIns.id );
					}
				}
				if ( otp[ 1 ] === false ) {
					let secretEmail = otp[ 0 ].secretEmail;
					let secretPhone = otp[ 0 ].secretPhone;
					tokenEmail = createNewToken( self._totpData, secretEmail );
					tokenPhone = createNewToken( self._totpData, secretPhone );
				}
				console.log( tokenEmail, tokenPhone );
				let result;
				try {
					result = await sendDataViaProvider.call(
						self,
						{ email, phone },
						{ email: tokenEmail, phone: tokenPhone },
						otp[ 0 ]
					);
					console.log( result );
					returnResp.email = {
						status: result.status,
						message: "TOKEN_SENT"
					};
					return req.res.json( returnResp );

				} catch ( error ) {
					returnResp.multi = {
						status: 500,
						message: error.message
					};
					return req.res.json( returnResp );

				}
			} );

		} else {
			if ( email ) {
				let otpData = {};
				await checkReRequestTime.call( this, req, { email } );
				let { secret, token } = createNewToken( this._totpData );
				if ( req.body.password ) {
					otpData.password = User.hashPassword( req.body.password );
				}
				otpData.secretEmail = secret;
				otpData.email = email;
				let otp;
				async function createOtpInstance ( done ) {
					try {
						otp = await Otp.findOrCreate(
							{
								where: {
									email: email
								},
								limit: 1,
								order: "id DESC"
							},
							otpData
						);
						done();

					} catch ( error ) {
						done( error );
					}
				}
				User.notifyObserversAround( 'otp instance', otpData, createOtpInstance, async function ( err ) {
					try {
						if ( err ) throw err;
						if ( otp[ 1 ] === true ) {
							if ( userIns ) {
								await otp[ 0 ].updateAttribute( "userId", userIns.id );
								otp[ 0 ].user( userIns );
							}
						}
						if ( otp[ 1 ] === false ) {
							secret = otp[ 0 ].secretEmail;
							token = createNewToken( self._totpData, secret );
						}
						console.log( token );
						User.emit( 'generatedToken', token );
						let result;

						result = await sendDataViaProvider.call(
							self,
							{ email },
							token,
							otp[ 0 ]
						);
						console.log( result );
						returnResp.email = {
							status: result.status,
							message: "TOKEN_SENT"
						};
						return req.res.json( returnResp );
					} catch ( error ) {
						returnResp.email = {
							status: 500,
							message: error.message
						};
						return req.res.json( returnResp );
					}
				} );

			}
			if ( phone && phone.phone ) {
				await checkReRequestTime.call( this, req, { phone } );
				let { secret, token } = createNewToken( this._totpData );
				let otpData = {};
				otpData.secretPhone = secret;
				otpData.phone = phone;
				phone.countryCode = data.phone.countryCode || this.defaultCountryCode;
				let otp;
				if ( req.body.password ) {
					otpData.password = User.hashPassword( req.body.password );
				}
				async function createOtpInstance ( done ) {
					try {
						otp = await Otp.findOrCreate(
							{
								where: {
									"phone.countryCode": phone.countryCode,
									"phone.phone": phone.phone
								},
								limit: 1,
								order: "id DESC"
							},
							otpData
						);
						done();
					} catch ( error ) {
						done( error );
					}
				}
				User.notifyObserversAround( 'otp instance', otpData, createOtpInstance, async function ( err ) {
					if ( err ) throw err;
					if ( otp[ 1 ] === true ) {
						if ( userIns ) {
							await otp[ 0 ].updateAttribute( "userId", userIns.id );
						}
					}
					if ( otp[ 1 ] === false ) {
						secret = otp[ 0 ].secretPhone;
						token = createNewToken( self._totpData, secret );
					}
					console.log( token );
					User.emit( 'generatedToken', token );
					let result;
					try {
						result = await sendDataViaProvider.call(
							self,
							{ phone },
							token,
							otp[ 0 ]
						);
						console.log( result );
						returnResp.phone = {
							status: result.status,
							message: "TOKEN_SENT"
						};
						return req.res.json( returnResp );
					} catch ( error ) {
						returnResp.phone = {
							status: 500,
							message: error.message
						};
						return req.res.json( returnResp );
					}
				} );
			}
		}
	} catch ( error ) {
		console.log( error );
		return req.res.json( {
			status: 400,
			message: error.message || error
		} );
	}
};

var checkReRequestTime = async function ( req, data, qFrmt ) {
	qFrmt = qFrmt || "or";
	let Otp = req.app.models[ this._modelName ];
	var result = await Otp.findOne(
		getQuery.call( this, qFrmt, data.email, data.phone )
	);
	if ( !result ) return true;
	let lastAttempt = _.get( result, `attempt.lastAttempt`, false );
	if ( !lastAttempt ) {
		_.set( result, `attempt.lastAttempt`, new Date() );
		result.save();
		return true;
	}
	let timeDiff = moment().diff( lastAttempt, "seconds" );
	let remSecs = this._resendAfter * 60 - timeDiff;
	if ( timeDiff < this._resendAfter * 60 ) {
		return Promise.reject(
			{
				status: 401,
				message: {
					details: `You can resend OTP after ${ remSecs } seconds`,
					timeStamp: moment( moment.now() ).add( remSecs, 'seconds' ).toISOString()
				}
			}
		);
	}
	let nAttempts = _.get( result, `attempt.attempts`, 0 );
	await result.updateAttribute( "attempt", {
		lastAttempt: new Date(),
		attempts: nAttempts + 1
	} );
	return true;
};
var createNewToken = function ( totpData, secret ) {
	let old = secret && true;
	secret = secret || speakeasy.generateSecret().base32;
	let token = speakeasy.totp(
		_.defaults(
			{
				secret: secret
			},
			totpData
		)
	);
	if ( old ) {
		return token;
	}
	return { secret, token };
};

var sendDataViaProvider = async function ( data, token, otpIns ) {
	let type, phone;
	if ( data.phone && data.phone.phone ) {
		type = "phone";
		data.phone.countryCode = data.phone.countryCode || this.defaultCountryCode;
		phone = [ data.phone.countryCode, data.phone.phone ].join( "" );
	}
	if ( data.email ) {
		type = "email";
	}
	if ( data.phone && data.phone.phone && data.email ) {
		type = "multi";
	}
	let User = this._UserModel;
	let query = getQuery.call( this, type, data.email, data.phone );
	let user = await User.findOne( query );
	let requestType = this._reqBody.requestType;
	if ( !user ) {
		//check if userIns is coming in body
		if ( this._reqBody.userIns ) {
			user = await User.findById( this._reqBody.userIns.id );
		}
	}
	let accessToken;
	let ttl = 500;
	if ( user ) {
		accessToken = await user.accessTokens.findOne();
		if ( !accessToken ) {
			accessToken = await user.accessTokens.create( { ttl: ttl } );
		}
	}
	let customMailFnData = {};
	customMailFnData.requestType = requestType;
	customMailFnData.user = user;
	customMailFnData.accessToken = accessToken;
	customMailFnData.otpMedium = type;
	customMailFnData.otpIns = otpIns;
	let result = await this._messageProvider(
		type,
		{ ...data, phone },
		token,
		customMailFnData
	);
	if ( result.status === 400 ) {
		err( `${ type.toUpperCase() }_PROVIDER_ERROR` );
	}
	return result;
};

var getQuery = function ( type, email = false, phone = false ) {
	let countryCode = false;

	if ( phone && phone.phone ) {
		countryCode = phone.countryCode || this.defaultCountryCode;
		phone = phone.phone;
	} else {
		phone = false;
	}
	let orArr = [];
	let andArr = [];
	if ( phone && countryCode ) {
		orArr.push( {
			and: [ { "phone.countryCode": countryCode }, { "phone.phone": phone } ]
		} );
		andArr.push( { "phone.countryCode": countryCode }, { "phone.phone": phone } );
	}
	if ( email ) {
		orArr.push( { email: email } );
		andArr.push( { email: email } );
	}
	let queryOr = {
		where: {
			or: orArr
		},
		order: "id DESC",
		limit: 1
	};
	let queryAnd = {
		where: {
			and: andArr
		},
		order: "id DESC",
		limit: 1

	};

	if ( type === "and" ) {
		return queryAnd;
	}
	return queryOr;
};

var defaultCallback = ( self, type, email, phone, result, redirect ) => async (
	err,
	user,
	info
) => {
	if ( err ) {
		return self.error( err );
	}
	user.updateAttributes( { username: _.get( info, `identity.profile.username` ) } );
	let emailFirstTime = false,
		phoneFirstTime = false;
	if ( !user && typeof redirect !== "function" ) {
		return self.fail( info );
	}
	if ( result.password ) {
		//might get logged out
		await user.updateAttribute( "password", result.password );
		await user.updateAttribute( "passwordSetup", true );
	}
	// todo WARN can verify both
	if ( phone && phone.phone && email ) {
		if ( !user.phoneVerified ) {
			phoneFirstTime = true;
		}
		if ( !user.emailVerified ) {
			emailFirstTime = true;
		}
		await user.updateAttribute( "phoneVerified", true );
		await user.updateAttribute( "emailVerified", true );
	} else {
		if ( phone && phone.phone && type === "phone" ) {
			if ( !user.phoneVerified ) {
				phoneFirstTime = true;
			}
			let phoneTmp = user.phone;
			let phonePhoneTmp = _.get( phoneTmp, `phone`, false );
			if ( !phonePhoneTmp || phonePhoneTmp !== phone.phone ) {
				await user.updateAttribute( "phone", phone );
			}
			await user.updateAttribute( "phoneVerified", true );
			await user.updateAttribute( "phoneSetup", true );
		}
		if ( email && type === "email" ) {
			if ( !user.emailVerified ) {
				emailFirstTime = true;
			}
			let emailTmp = user.email;
			if ( !emailTmp || emailTmp !== email ) {
				await user.updateAttribute( "email", email );
			}
			await user.updateAttribute( "emailVerified", true );
			await user.updateAttribute( "emailSetup", true );
		}
	}
	await result.updateAttributes( { userId: user.id } );

	if ( typeof redirect === "function" ) {
		return await redirect( err, user, info, emailFirstTime, phoneFirstTime );
	} else {
		self.success( user, info );
	}
};

var createProfile = async function ( result ) {
	// if existing user
	let user, userIdentity, externalId;
	if ( result.userId ) {
		user = await result.user.get();
		userIdentity = ( await user.identities.getAsync() ).map( i => { if ( i.provider === this.provider ) return i; } );
		externalId = userIdentity[ 0 ].externalId;
	}
	if ( !externalId ) {
		externalId = makeid( 10 );
	}
	let obj = {};
	if ( result.email ) {
		obj.email = result.email;
		obj.username = obj.email;
		obj.emails = [
			{
				value: obj.email
			}
		];
		obj.id = externalId;
		delete result[ "email" ]; //changes
	}
	if ( result.phone && result.phone.phone ) {
		obj.phone = result.phone;
		result.phone.countryCode =
			result.phone.countryCode || this.defaultCountryCode;
		let ph = [ result.phone.countryCode, result.phone.phone ].join( "" );
		if ( !obj.username ) {
			obj.username = ph;
		}
		if ( !obj.emails ) {
			obj.emails = [
				{
					value: obj.email || ph + `@passport-otp.com`
					//     if email comes with otpInstance
				}
			];
		}
		if ( !obj.id ) {
			obj.id = externalId;
		}
		delete result[ "phone" ];
	}
	return obj;
};

Strategy.prototype.submitToken = async function ( req, data, token, type ) {
	const self = this;
	let email = data.email || false;
	let phone = data.phone || false;
	let result = await self.verifyToken( req, data, token, type );
	let newUser = false;
	if ( !result.userId ) {
		newUser = true;
	}
	// result = result.toJSON();
	// result.emailVerified = email && true;
	// result.phoneVerified = phone && phone.phone && true;
	let phoneVerReq = this.phoneVerReq;
	let emailVerReq = this.emailVerReq;
	let User = this._UserModel;
	if ( result.userId ) {
		//this was an authenticated request
		let user = await User.findById( result.userId );
		if ( !user ) {
			return req.res.json( {
				status: 400,
				message: "userId not found"
			} );
		}
		// Assuming that the fields which are coming in an result(OTP) instance
		// contains the latest information
		// If not (email || phone) update respected to existing user value
		// There might arrive an issue in which an OTP instance will contain both
		// email and phone field .... // todo make sure single update stores in OTP instance
		if ( !_.get( result, `phone.phone`, false ) ) {
			let phoneTmp = user.phone;
			result.phone = phoneTmp;
		}
		if ( !result.email ) {

			let tmpEmail = user.email;
			result.email = tmpEmail;
		}
	}
	var profile = await createProfile.call( this, result );
	let redirect = this.redirectEnabled || false;
	if ( !redirect ) {
		redirect = async function ( err, user, info, emailFirstTime, phoneFirstTime ) {
			if ( err ) return req.res.json( { err } );
			let ctx = {};
			ctx.user = user,
				ctx.newUser = newUser;
			ctx.emailFirstTime = emailFirstTime;
			ctx.phoneFirstTime = phoneFirstTime;
			ctx.extras = req.body.extras;

			await new Promise( ( resolve, reject ) => {
				User.notifyObserversOf( "after verification", ctx, function ( err ) {
					if ( err ) reject( err );
					resolve();
				} );
			} );
			// p.then(resp => {

			// }).catch(e => console.log(e))
			let respObj = user.toJSON();

			if ( phoneVerReq && emailVerReq ) {
				if ( user.emailVerified && user.phoneVerified ) {
					respObj.accessToken = info.accessToken;
				}
			} else {
				if ( phoneVerReq && user.phoneVerified ) {
					respObj.accessToken = info.accessToken;
				}
				if ( emailVerReq && user.emailVerified ) {
					respObj.accessToken = info.accessToken;
				}
			}
			if ( !respObj.accessToken ) {
				user.accessTokens.destroyAll( {
					where: user.userId
				} );
			}
			return req.res.json( {
				status: 200,
				...respObj
			} );
		};
	}
	return self._verify(
		req,
		null,
		null,
		profile,
		defaultCallback( self, type, email, phone, result, redirect )
	);
};

Strategy.prototype.verifyToken = async function (
	req,
	data,
	tokenEnteredByUser,
	type
) {
	let Otp = req.app.models[ this._modelName ];
	let query;
	if ( type === "multi" ) {
		query = getQuery.call( this, "and", data.email, data.phone );
	} else if ( type === "phone" ) {
		query = getQuery.call( this, "or", null, data.phone );
	}
	else if ( type === "email" ) {
		query = getQuery.call( this, "or", data.email, null );
	}
	let result = await Otp.findOne( query );
	if ( !result ) {
		err( `INVALID_DATA` );
	}
	if ( result ) {
		console.log( `IDENTITY_FOUND \n${ JSON.stringify( data ) }\n${ JSON.stringify( result ) }` );
	}
	let validToken = false;
	let verifDataOps = this._totpData;

	let emailSecret, phoneSecret;
	let tokenEmail, tokenPhone;
	if ( type === "multi" ) {
		emailSecret = result.secretEmail;
		phoneSecret = result.secretPhone;
		tokenEmail = tokenEnteredByUser.email;
		tokenPhone = tokenEnteredByUser.phone;
		if ( !tokenEmail || !tokenPhone ) {
			return Promise.reject( `BOTH_TOKEN_NEEDED` );
		}
		verifDataOps.secret = emailSecret;
		verifDataOps.token = tokenEmail;
		let tokenValidates = speakeasy.totp.verify( verifDataOps );
		if ( !tokenValidates ) {
			validToken = false;
		} else {
			validToken = true;
		}
		verifDataOps.secret = phoneSecret;
		verifDataOps.token = tokenPhone;
		tokenValidates = speakeasy.totp.verify( verifDataOps );
		if ( !tokenValidates ) {
			validToken = false;
		}
	} else if ( type === "email" ) {
		emailSecret = result.secretEmail;
		tokenEmail = tokenEnteredByUser;
		verifDataOps.secret = emailSecret;
		verifDataOps.token = tokenEmail;
		let tokenValidates = speakeasy.totp.verify( verifDataOps );
		if ( !tokenValidates ) {
			validToken = false;
		} else {
			validToken = true;
		}
	} else if ( type === "phone" ) {

		phoneSecret = result.secretPhone;
		tokenPhone = tokenEnteredByUser;
		verifDataOps.secret = phoneSecret;
		verifDataOps.token = tokenPhone;
		console.log( `checking for ${ JSON.stringify( verifDataOps ) } ` );
		let tokenValidates = speakeasy.totp.verify( verifDataOps );
		if ( !tokenValidates ) {
			validToken = false;
		} else {
			validToken = true;
		}
	}

	// _.defaults(
	//   {
	//     secret: result.secret,
	//     token: tokenEnteredByUser
	//   },
	//   this._totpData
	// );
	// let tokenValidates = speakeasy.totp.verify(verifDataOps);
	if ( !validToken ) {
		return Promise.reject( `INVALID_TOKEN` );
	}
	return result;
};

module.exports = Strategy;
