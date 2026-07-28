# BrainOutput Community Edition — zero-dependency Node app.
# Runs as a non-root user; the store lives on a volume so an instance is disposable and its data is not.
FROM node:22-alpine
RUN addgroup -S bo && adduser -S -G bo bo
WORKDIR /app
COPY --chown=bo:bo . /app
RUN rm -rf /app/.git /app/node_modules /app/*.test.mjs
USER bo
ENV BO_CE_DATA=/data BO_CE_WEB_PORT=4177 BO_CE_WEB_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 4177
# Refuses to start on 0.0.0.0 without BO_CE_ACCESS_TOKEN — pass one in.
CMD ["node", "bo-community.mjs", "serve"]
