package com.company.core;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@SpringBootApplication
@ComponentScan(basePackages = "com.company")
@EntityScan(basePackages = "com.company")
@EnableJpaRepositories(basePackages = "com.company")
@EnableJpaAuditing
public class CompanyPlatformApplication {

    public static void main(String[] args) {
        SpringApplication.run(CompanyPlatformApplication.class, args);
    }
}
