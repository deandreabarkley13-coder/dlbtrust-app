# OpenACH origination platform (github.com/openach/openach) packaged for Northflank.
#
# Replaces the IONOS-hosted ach.dlbtrust.cloud container: same Yii 1.x app and
# the same /openach/api surface the trust's ACH rail already speaks, but built
# from a pinned upstream commit, backed by a Northflank PostgreSQL addon and
# configured entirely from the environment (see docker-entrypoint.sh).
FROM php:7.4-apache

ARG OPENACH_REF=8c3df400823b2eced60ec4989a2d37d60133be2e

# php:7.4 is built on Debian bullseye, whose repositories have moved to the
# archive; the image's default sources 404 and the build fails without this.
# bullseye-security/-updates no longer serve packages, so they are dropped.
RUN sed -i -e 's#http://deb.debian.org/debian#http://archive.debian.org/debian#' \
      -e '/bullseye-security/d' -e '/bullseye-updates/d' /etc/apt/sources.list \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99archive \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git patch unzip libpq-dev libzip-dev libpng-dev \
      libjpeg62-turbo-dev libfreetype6-dev libonig-dev postgresql-client \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" pdo_pgsql pgsql gd zip bcmath mbstring \
    && a2enmod rewrite headers \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/openach

# Pinned tarball rather than a floating clone, so a rebuild cannot silently
# change the ACH origination logic under the trust's payments.
RUN curl -fsSL "https://codeload.github.com/openach/openach/tar.gz/${OPENACH_REF}" \
      | tar -xz --strip-components=1 \
    && COMPOSER_ALLOW_SUPERUSER=1 composer config --no-plugins allow-plugins.cweagans/composer-patches true \
    && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --no-progress \
    && ln -sfn vendor/yiisoft/yii/framework yii \
    && mkdir -p protected/runtime/db assets \
    && chown -R www-data:www-data protected/runtime assets

COPY patches/ /tmp/openach-patches/
RUN patch -p1 -d vendor/yiisoft/yii < /tmp/openach-patches/yii-1.1.x-pgsql-constraint-types.diff \
    && rm -rf /tmp/openach-patches

COPY migrations/ /opt/openach/migrations/
COPY apache-openach.conf /etc/apache2/sites-available/000-default.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY openach-bootstrap.sh /usr/local/bin/openach-bootstrap
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/openach-bootstrap

ENV OPENACH_ROOT=/var/www/openach \
    APACHE_DOCUMENT_ROOT=/var/www/openach

EXPOSE 80

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["apache2-foreground"]
